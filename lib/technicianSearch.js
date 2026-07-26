export function createTechnicianSearch(db) {
    async function searchTechnicians({
        city = '',
        state = '',
        areaCode = '',
        hasSupplies = '',
        willingToTravel = '',
        weekends = '',
        limit = 10
    } = {}) {
        const conditions = [];
        const values = [];

        function addCondition(sql, value) {
            values.push(value);
            conditions.push(
                sql.replace('$VALUE', `$${values.length}`)
            );
        }

        if (city.trim()) {
            addCondition(
                `city ILIKE $VALUE`,
                city.trim()
            );
        }

        if (state.trim()) {
            addCondition(
                `state ILIKE $VALUE`,
                state.trim()
            );
        }

        if (areaCode.trim()) {
            addCondition(
                `area_code ILIKE $VALUE`,
                areaCode.trim()
            );
        }

        if (hasSupplies.trim()) {
            addCondition(
                `has_supplies ILIKE $VALUE`,
                `%${hasSupplies.trim()}%`
            );
        }

        if (willingToTravel.trim()) {
            addCondition(
                `willing_to_travel ILIKE $VALUE`,
                `%${willingToTravel.trim()}%`
            );
        }

        if (weekends.trim()) {
            addCondition(
                `willing_to_work_weekends ILIKE $VALUE`,
                `%${weekends.trim()}%`
            );
        }

        const safeLimit = Math.min(
            Math.max(Number(limit) || 10, 1),
            25
        );

        values.push(safeLimit);

        const whereClause =
            conditions.length > 0
                ? `WHERE ${conditions.join(' AND ')}`
                : '';

        const result = await db.query(
            `
            SELECT
                id,
                first_name,
                last_name,
                full_name,
                phone_number,
                email,
                city,
                state,
                area_code,
                cleaning_experience,
                reliable_transportation,
                willing_to_travel,
                willing_to_work_weekends,
                has_supplies,
                currently_employed
            FROM public.technicians
            ${whereClause}
            ORDER BY
                CASE
                    WHEN reliable_transportation ILIKE '%yes%'
                    THEN 0
                    ELSE 1
                END,
                first_name,
                last_name
            LIMIT $${values.length}
            `,
            values
        );

        return result.rows;
    }

    return {
        searchTechnicians
    };
}
