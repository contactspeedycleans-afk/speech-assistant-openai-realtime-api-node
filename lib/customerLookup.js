export function createCustomerLookup(db) {
    async function findCustomerByPhone(phone) {
        if (!phone) {
            return null;
        }

        const digits = String(phone).replace(/\D/g, '');

        let normalizedPhone = '';

        if (digits.length === 10) {
            normalizedPhone = `1${digits}`;
        } else if (
            digits.length === 11 &&
            digits.startsWith('1')
        ) {
            normalizedPhone = digits;
        } else {
            normalizedPhone = digits;
        }

        console.log(
            'Normalized caller phone:',
            normalizedPhone
        );

        const result = await db.query(
            `
            SELECT *
            FROM public.customers
            WHERE REGEXP_REPLACE(
                phone_normalized,
                '[^0-9]',
                '',
                'g'
            ) = $1
            LIMIT 1
            `,
            [normalizedPhone]
        );

        return result.rows[0] || null;
    }

    async function findRecentCalls(phone) {
        if (!phone) {
            return [];
        }

        const digits = String(phone).replace(/\D/g, '');

        const normalizedPhone =
            digits.length === 10
                ? `1${digits}`
                : digits;

        const result = await db.query(
            `
            SELECT summary, sentiment, started_at
            FROM public.call_logs
            WHERE REGEXP_REPLACE(
                phone_number,
                '[^0-9]',
                '',
                'g'
            ) = $1
            ORDER BY started_at DESC
            LIMIT 3
            `,
            [normalizedPhone]
        );

        return result.rows;
    }

    return {
        findCustomerByPhone,
        findRecentCalls
    };
}
