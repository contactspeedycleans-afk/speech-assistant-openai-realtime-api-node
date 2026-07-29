export function createCustomerLookup(db) {
    function getPhoneVariants(phone) {
        if (!phone) {
            return [];
        }

        const digits = String(phone).replace(/\D/g, '');

        if (!digits) {
            return [];
        }

        const variants = new Set();

        variants.add(digits);

        if (digits.length === 10) {
            variants.add(`1${digits}`);
        }

        if (
            digits.length === 11 &&
            digits.startsWith('1')
        ) {
            variants.add(digits.slice(1));
        }

        return Array.from(variants);
    }

    async function findCustomerByPhone(phone) {
        const phoneVariants = getPhoneVariants(phone);

        if (phoneVariants.length === 0) {
            console.log(
                'Customer lookup skipped: no valid phone number.'
            );

            return null;
        }

        console.log(
            'Customer phone variants:',
            phoneVariants
        );

        const result = await db.query(
            `
            SELECT *
            FROM public.customers
            WHERE RIGHT(
                REGEXP_REPLACE(
                    COALESCE(
                        phone_normalized,
                        phone,
                        ''
                    ),
                    '[^0-9]',
                    '',
                    'g'
                ),
                10
            ) = RIGHT($1, 10)
            ORDER BY id DESC
            LIMIT 1
            `,
            [phoneVariants[0]]
        );

        const customer =
            result.rows[0] || null;

        if (customer) {
            console.log(
                'Customer matched by phone:',
                {
                    id: customer.id,
                    first_name:
                        customer.first_name,
                    last_name:
                        customer.last_name,
                    phone:
                        customer.phone,
                    phone_normalized:
                        customer.phone_normalized
                }
            );
        } else {
            console.log(
                'No PostgreSQL customer matched phone:',
                phone
            );
        }

        return customer;
    }

    async function findRecentCalls(phone) {
        const phoneVariants = getPhoneVariants(phone);

        if (phoneVariants.length === 0) {
            return [];
        }

        const result = await db.query(
            `
            SELECT
                summary,
                sentiment,
                started_at
            FROM public.call_logs
            WHERE RIGHT(
                REGEXP_REPLACE(
                    COALESCE(
                        phone_number,
                        ''
                    ),
                    '[^0-9]',
                    '',
                    'g'
                ),
                10
            ) = RIGHT($1, 10)
            ORDER BY started_at DESC
            LIMIT 3
            `,
            [phoneVariants[0]]
        );

        console.log(
            'Recent calls found:',
            result.rows.length
        );

        return result.rows;
    }

    return {
        findCustomerByPhone,
        findRecentCalls
    };
}
