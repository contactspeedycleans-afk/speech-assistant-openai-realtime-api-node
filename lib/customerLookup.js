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

    function getLastTenDigits(phone) {
        const digits = String(phone || '').replace(/\D/g, '');

        if (digits.length < 10) {
            return '';
        }

        return digits.slice(-10);
    }

    async function findCustomerByPhone(phone) {
        const phoneVariants = getPhoneVariants(phone);
        const phoneKey = getLastTenDigits(phone);

        if (
            phoneVariants.length === 0 ||
            !phoneKey
        ) {
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
            SELECT
                c.*,

                profile.last_booking_date,
                profile.next_booking_date,
                profile.next_service_type,
                profile.next_arrival_window,
                profile.total_bookings,
                profile.total_calls,
                profile.last_call_at,
                profile.open_complaint_count

            FROM public.customers c

            LEFT JOIN public.emma_customer_profile profile
                ON profile.customer_id = c.id

            WHERE RIGHT(
                REGEXP_REPLACE(
                    COALESCE(
                        NULLIF(c.phone_normalized, ''),
                        NULLIF(c.phone, ''),
                        ''
                    ),
                    '[^0-9]',
                    '',
                    'g'
                ),
                10
            ) = $1

            ORDER BY
                CASE
                    WHEN c.first_name IS NOT NULL
                         OR c.last_name IS NOT NULL
                    THEN 0
                    ELSE 1
                END,
                CASE
                    WHEN c.octopus_customer_id IS NOT NULL
                    THEN 0
                    ELSE 1
                END,
                c.id DESC

            LIMIT 1
            `,
            [phoneKey]
        );

        const customer =
            result.rows[0] || null;

        if (customer) {
            console.log(
                'Customer matched by phone:',
                {
                    id: customer.id,
                    octopus_customer_id:
                        customer.octopus_customer_id,
                    first_name:
                        customer.first_name,
                    last_name:
                        customer.last_name,
                    phone:
                        customer.phone,
                    phone_normalized:
                        customer.phone_normalized,
                    total_bookings:
                        customer.total_bookings,
                    total_calls:
                        customer.total_calls,
                    next_booking_date:
                        customer.next_booking_date,
                    next_arrival_window:
                        customer.next_arrival_window,
                    open_complaint_count:
                        customer.open_complaint_count
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
        const phoneKey = getLastTenDigits(phone);

        if (!phoneKey) {
            console.log(
                'Recent-call lookup skipped: no valid phone number.'
            );

            return [];
        }

        const result = await db.query(
            `
            SELECT
                id,
                customer_id,
                call_sid,
                call_mode,
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
            ) = $1
            ORDER BY started_at DESC
            LIMIT 3
            `,
            [phoneKey]
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
