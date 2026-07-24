export function createBookingLookup(db) {
    async function findCustomerBookingCount(customerId) {
        if (!customerId) {
            return 0;
        }

        const result = await db.query(
            `
            SELECT COUNT(*)::int AS booking_count
            FROM public.bookings
            WHERE customer_id = $1
            `,
            [customerId]
        );

        return result.rows[0]?.booking_count || 0;
    }

    async function findCustomerBookings(customerId) {
        if (!customerId) {
            return [];
        }

        const result = await db.query(
            `
            SELECT
                octopus_booking_id,
                service_type,
                booking_date,
                arrival_window,
                status,
                labor_hours,
                technician_count,
                estimated_total,
                final_total,
                special_requests
            FROM public.bookings
            WHERE customer_id = $1
            ORDER BY booking_date DESC
            LIMIT 5
            `,
            [customerId]
        );

        return result.rows;
    }

    return {
        findCustomerBookingCount,
        findCustomerBookings
    };
}
