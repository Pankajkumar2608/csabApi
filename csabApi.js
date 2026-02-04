// server.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const TABLE_NAME = "csab_final"; // !!! IMPORTANT: Change this if your table name is different !!!

// --- Database Connection ---
const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: 5432, // Default PostgreSQL port
  ssl: {
    require: true, // Neon requires SSL
  },
});

pool.on('connect', () => {
  console.log('Connected to the Database via Pool');
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1); // Exit if DB connection has critical error
});

// --- Express App Setup ---
const app = express();

// --- Middleware ---
app.use(cors({
    origin: ["https://www.motivationkaksha.in", "https://motivationkaksha.in", "http://127.0.0.1:5500"],
    credentials: true
}));
app.use(express.json());

// --- Helper Functions ---
function calculateLowerMargin(userRank) {
    if (userRank === null || isNaN(userRank) || userRank < 1) return 0;
    if (userRank <= 10000) return 1500;
    if (userRank <= 20000) return 2500;
    if (userRank <= 30000) return 3200;
    if (userRank <= 40000) return 3900;
    if (userRank <= 50000) return 4500;
    if (userRank <= 60000) return 5000;
    if (userRank <= 70000) return 5500;
    if (userRank <= 80000) return 6000;
    if (userRank <= 90000) return 8500;
    if (userRank <= 100000) return 10500;
    if (userRank <= 150000) return 12500;
    if (userRank <= 210000) return 20000;
    return 30000;
}

function safeRankToIntSQL(columnName) {
    return `NULLIF(regexp_replace("${columnName}", '[^0-9]', '', 'g'), '')::integer`;
}

// --- API Routes ---
app.get('/api/options', async (req, res) => {
    const types = req.query.types ? req.query.types.split(',') : [];
    const optionsData = {};
    const validTypes = {
        years: '"Year"',
        rounds: '"Round"',
        quotas: '"Quota"',
        seatTypes: '"Seat Type"',
        genders: '"Gender"',
        institutes: '"Institute"',
        programs: '"Academic Program Name"'
    };

    try {
        const client = await pool.connect();
        try {
            const promises = types.map(async (type) => {
                const columnName = validTypes[type];
                if (!columnName) return;

                const queryText = `SELECT DISTINCT ${columnName} FROM "${TABLE_NAME}" WHERE ${columnName} IS NOT NULL AND ${columnName}::text <> '' ORDER BY ${columnName} ASC`;
                const result = await client.query(queryText);
                optionsData[type] = result.rows.map(row => row[Object.keys(row)[0]]);

                if (type === 'years') {
                    optionsData[type].sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
                }
                 if (type === 'rounds') {
                    optionsData[type].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
                }
            });

            await Promise.all(promises);
            res.json(optionsData);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error fetching dropdown options:", err);
        res.status(500).json({ message: "Error fetching filter options." });
    }
});

app.get('/api/colleges', async (req, res) => {
    const {
        rank, seatType, year, round, quota, gender, institute, program,
        page = 1, limit = 25, fetchAll = 'false'
    } = req.query;

    if (!seatType) {
        return res.status(400).json({ message: "Seat Type (Category) is required." });
    }
    const userRank = rank ? parseInt(rank, 10) : null;
    if (rank && (isNaN(userRank) || userRank < 1)) {
        return res.status(400).json({ message: "Invalid Rank provided." });
    }
    const currentPage = parseInt(page, 10) || 1;
    const itemsPerPage = parseInt(limit, 10) || 25;
    const offset = (currentPage - 1) * itemsPerPage;
    const shouldFetchAll = fetchAll === 'true';

    let queryParams = [];
    let paramIndex = 1;
    let baseSelect = `SELECT "Institute", "Academic Program Name" as program_name, "Quota", "Seat Type" as seat_type, "Gender", "Opening Rank" as opening_rank, "Closing Rank" as closing_rank, "Year", "Round" FROM "${TABLE_NAME}"`;
    let countSelect = `SELECT COUNT(*) FROM "${TABLE_NAME}"`;
    let whereClauses = [];

    whereClauses.push(`"Seat Type" = $${paramIndex++}`);
    queryParams.push(seatType);

    if (year) { whereClauses.push(`"Year" = $${paramIndex++}`); queryParams.push(parseInt(year, 10)); }
    if (round) { whereClauses.push(`"Round" = $${paramIndex++}`); queryParams.push(parseInt(round, 10)); }
    if (quota) { whereClauses.push(`"Quota" = $${paramIndex++}`); queryParams.push(quota); }
    if (gender) { whereClauses.push(`"Gender" = $${paramIndex++}`); queryParams.push(gender); }
    if (institute) { whereClauses.push(`"Institute" = $${paramIndex++}`); queryParams.push(institute); }
    if (program) {
        whereClauses.push(`"Academic Program Name" ILIKE $${paramIndex++}`);
        queryParams.push(`%${program}%`);
    }

    const specificInstituteSelected = !!institute;
    if (userRank && !specificInstituteSelected) {
        const lowerMargin = calculateLowerMargin(userRank);
        const minAllowedRank = Math.max(1, userRank - lowerMargin);
        whereClauses.push(`${safeRankToIntSQL("Closing Rank")} >= $${paramIndex++}`);
        queryParams.push(minAllowedRank);
    }

    let whereString = "";
    if (whereClauses.length > 0) {
        whereString = ` WHERE ${whereClauses.join(" AND ")}`;
    }

    let orderByClauses = [
        `"Year" DESC`, // Year still important for context if multiple years selected
        // Round might be less critical if user selects a specific round
        // `"Round" DESC`, // Keep if user can select multiple rounds
    ];
     // Add Round DESC if no specific round is selected or if it's generally desired
    if (!round) { // Or based on your UI logic for round selection
        orderByClauses.push(`"Round" DESC`);
    }


    let sortParamsCount = 0;

    if (userRank && !specificInstituteSelected) {
        orderByClauses.push(`ABS(${safeRankToIntSQL("Closing Rank")} - $${paramIndex++}) ASC NULLS LAST`);
        queryParams.push(userRank);
        sortParamsCount++;
    }
    // Add default secondary sorting
    orderByClauses.push(`"Institute" ASC`);
    orderByClauses.push(`"Academic Program Name" ASC`);
    
    let orderByString = ` ORDER BY ${orderByClauses.join(", ")}`;

    try {
        const client = await pool.connect();
        try {
            let totalCount = 0;
            if (!shouldFetchAll) {
                const countParams = queryParams.slice(0, queryParams.length - sortParamsCount);
                const countResult = await client.query(countSelect + whereString, countParams);
                totalCount = parseInt(countResult.rows[0].count, 10);
            }

            let finalQuery = baseSelect + whereString + orderByString;
            const queryParamsForData = [...queryParams]; // Clone for data query

            if (!shouldFetchAll) {
                finalQuery += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
                queryParamsForData.push(itemsPerPage);
                queryParamsForData.push(offset);
            }
            
            const resultData = await client.query(finalQuery, queryParamsForData);
            let fetchedRows = resultData.rows;

            // --- START OF NEW JAVASCRIPT SORTING LOGIC ---
            if (userRank && !specificInstituteSelected && fetchedRows.length > 0) {
                const TARGET_ANCHOR_RANK_OFFSET = 1000;
                const TARGET_ANCHOR_RANGE = 500; // Adjust as needed

                fetchedRows.sort((a, b) => {
                    const ur = userRank;
                    // Closing ranks are strings from DB, convert to number for comparison
                    const crA = a.closing_rank !== null && a.closing_rank.trim() !== '' && !isNaN(Number(a.closing_rank)) ? Number(a.closing_rank) : Infinity;
                    const crB = b.closing_rank !== null && b.closing_rank.trim() !== '' && !isNaN(Number(b.closing_rank)) ? Number(b.closing_rank) : Infinity;

                    if (crA === Infinity && crB === Infinity) { // If both invalid, use name sort
                        const instComp = (a.Institute || "").localeCompare(b.Institute || "");
                        if (instComp !== 0) return instComp;
                        return (a.program_name || "").localeCompare(b.program_name || "");
                    }
                    if (crA === Infinity) return 1; // Invalid ranks go to the bottom
                    if (crB === Infinity) return -1;

                    const targetAnchorRank = Math.max(1, ur - TARGET_ANCHOR_RANK_OFFSET);
                    let categoryA, categoryB;

                    // Category for A
                    if (crA <= ur) {
                        categoryA = (Math.abs(crA - targetAnchorRank) <= TARGET_ANCHOR_RANGE) ? 1 : 2;
                    } else {
                        categoryA = 3;
                    }
                    // Category for B
                    if (crB <= ur) {
                        categoryB = (Math.abs(crB - targetAnchorRank) <= TARGET_ANCHOR_RANGE) ? 1 : 2;
                    } else {
                        categoryB = 3;
                    }

                    if (categoryA !== categoryB) {
                        return categoryA - categoryB;
                    }

                    // Secondary sort within the same category
                    switch (categoryA) {
                        case 1: // Sweet Spot (CR <= UR and close to targetAnchorRank)
                            const distA_target = Math.abs(crA - targetAnchorRank);
                            const distB_target = Math.abs(crB - targetAnchorRank);
                            if (distA_target !== distB_target) return distA_target - distB_target;
                            // Fallthrough to CR sort if equally distant
                        case 2: // Other Achievable (CR <= UR)
                            if (crA !== crB) return crA - crB; // Lower CR is better
                            break;
                        case 3: // Aspirational/Stretch (CR > UR)
                            // Closer to userRank is better (smaller positive difference)
                            if (crA !== crB) return crA - crB;
                            break;
                    }

                    // Final tie-breaker: Institute, then Program Name
                    const instComparison = (a.Institute || "").localeCompare(b.Institute || "");
                    if (instComparison !== 0) return instComparison;
                    return (a.program_name || "").localeCompare(b.program_name || "");
                });
            }
            // --- END OF NEW JAVASCRIPT SORTING LOGIC ---

            const results = fetchedRows.map(row => ({
                id: `${row.Institute}-${row.program_name}-${row.Quota}-${row.seat_type}-${row.Gender}-${row.Year}-${row.Round}`.toLowerCase().replace(/[^a-z0-9\-_]/g, "-").replace(/-+/g,'-').replace(/^-+|-+$/g, ''),
                ...row
            }));

            if (shouldFetchAll) {
                totalCount = results.length;
            }

            res.json({
                results: results,
                totalCount: totalCount,
                currentPage: shouldFetchAll ? 1 : currentPage,
                totalPages: shouldFetchAll ? 1 : Math.ceil(totalCount / itemsPerPage),
            });

        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Database Query Error in /api/colleges:", err);
        console.error("Query Params (at time of error):", queryParamsForData || queryParams);
        res.status(500).json({ message: "Error fetching college data." });
    }
});

app.get('/api/trends', async (req, res) => {
    const { institute, program, quota, seatType, gender, round } = req.query;

    if (!institute || !program || !quota || !seatType || !gender || !round) {
        return res.status(400).json({ message: "Missing required parameters for trend data." });
    }

    const queryText = `
        SELECT "Year" as year, "Opening Rank" as opening_rank, "Closing Rank" as closing_rank
        FROM "${TABLE_NAME}"
        WHERE "Institute" = $1
          AND "Academic Program Name" = $2
          AND "Quota" = $3
          AND "Seat Type" = $4
          AND "Gender" = $5
          AND "Round" = $6
        ORDER BY "Year" ASC
    `;
    const queryParams = [institute, program, quota, seatType, gender, parseInt(round, 10)];

    try {
        const client = await pool.connect();
        try {
            const result = await client.query(queryText, queryParams);
            res.json(result.rows);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error fetching trend data:", err);
        res.status(500).json({ message: "Error fetching trend data." });
    }
});

app.get('/', (req, res) => {
  res.send('College Predictor API is running!');
});

app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err.stack || err);
  res.status(500).json({ message: err.message || 'Something went wrong on the server!' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Connecting to DB: ${process.env.PGHOST}/${process.env.PGDATABASE}`);
});
