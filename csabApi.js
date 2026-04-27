const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true }
});

// -------- helper --------
function calculateLowerMargin(rank) {
    if (rank <= 10000) return 1500;
    if (rank <= 20000) return 2500;
    if (rank <= 50000) return 5000;
    if (rank <= 100000) return 10000;
    return 20000;
}

// -------- route --------
app.get('/api/colleges', async (req, res) => {
    const {
        rank, seatType, year, round,
        quota, gender, institute, program,
        page = 1, limit = 25
    } = req.query;

    if (!seatType) {
        return res.status(400).json({ message: "Seat Type required" });
    }

    const userRank = rank ? parseInt(rank) : null;
    const currentPage = parseInt(page);
    const itemsPerPage = parseInt(limit);
    const offset = (currentPage - 1) * itemsPerPage;

    let queryParams = [];
    let queryParamsForData = [];
    let paramIndex = 1;

    const baseQuery = `
        SELECT 
            "Institute",
            "Academic Program Name" as program_name,
            "Quota",
            seat_type,
            "Gender",
            opening_rank,
            closing_rank,
            "Year",
            "Round"
        FROM csab_final
    `;

    let where = [];

    // filters
    where.push(`seat_type = $${paramIndex++}`);
    queryParams.push(seatType);

    if (year) {
        where.push(`"Year" = $${paramIndex++}`);
        queryParams.push(parseInt(year));
    }

    if (round) {
        where.push(`"Round" = $${paramIndex++}`);
        queryParams.push(parseInt(round));
    }

    if (quota) {
        where.push(`"Quota" = $${paramIndex++}`);
        queryParams.push(quota);
    }

    if (gender) {
        where.push(`"Gender" = $${paramIndex++}`);
        queryParams.push(gender);
    }

    if (institute) {
        where.push(`"Institute" = $${paramIndex++}`);
        queryParams.push(institute);
    }

    if (program) {
        where.push(`"Academic Program Name" ILIKE $${paramIndex++}`);
        queryParams.push(`%${program}%`);
    }

    // rank filter
    if (userRank && !institute) {
        const minRank = Math.max(1, userRank - calculateLowerMargin(userRank));
        where.push(`closing_rank >= $${paramIndex++}`);
        queryParams.push(minRank);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // sorting
    let orderBy = `"Year" DESC, "Round" DESC`;

    if (userRank && !institute) {
        orderBy += `, ABS(closing_rank - $${paramIndex++}) ASC`;
        queryParams.push(userRank);
    }

    orderBy += `, "Institute" ASC`;

    try {
        const client = await pool.connect();

        try {
            const countResult = await client.query(
                `SELECT COUNT(*) FROM csab_final ${whereClause}`,
                queryParams.slice(0, queryParams.length - (userRank && !institute ? 1 : 0))
            );

            const totalCount = parseInt(countResult.rows[0].count);

            let finalQuery = `
                ${baseQuery}
                ${whereClause}
                ORDER BY ${orderBy}
                LIMIT $${paramIndex++} OFFSET $${paramIndex++}
            `;

            queryParamsForData = [...queryParams];
            queryParamsForData.push(itemsPerPage);
            queryParamsForData.push(offset);

            const result = await client.query(finalQuery, queryParamsForData);

            res.json({
                results: result.rows,
                totalCount,
                currentPage,
                totalPages: Math.ceil(totalCount / itemsPerPage)
            });

        } finally {
            client.release();
        }

    } catch (err) {
        console.error("DB ERROR:", err);
        console.error("PARAMS:", queryParamsForData || queryParams);

        res.status(500).json({
            message: "Database error"
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});
