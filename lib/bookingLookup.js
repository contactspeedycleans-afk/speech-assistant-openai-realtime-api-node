export function createBookingLookup(db) {
    async function findCustomerBookingCount(
        customerId
    ) {
        if (!customerId) {
            console.log(
                'Booking count skipped: no customer ID.'
            );

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

        const bookingCount =
            Number(
                result.rows[0]?.booking_count ||
                0
            );

        console.log(
            'Booking count for customer:',
            {
                customerId,
                bookingCount
            }
        );

        return bookingCount;
    }

    async function findCustomerBookings(
        customerId
    ) {
        if (!customerId) {
            console.log(
                'Booking lookup skipped: no customer ID.'
            );

            return [];
        }

        const result = await db.query(
            `
            SELECT
                id,
                customer_id,
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
            ORDER BY
                booking_date DESC NULLS LAST,
                id DESC
            LIMIT 5
            `,
            [customerId]
        );

        console.log(
            'Bookings loaded for customer:',
            {
                customerId,
                bookingCount:
                    result.rows.length,
                bookings:
                    result.rows.map(
                        booking => ({
                            id: booking.id,
                            octopus_booking_id:
                                booking.octopus_booking_id,
                            booking_date:
                                booking.booking_date,
                            status:
                                booking.status,
                            service_type:
                                booking.service_type
                        })
                    )
            }
        );

        return result.rows;
    }

    return {
        findCustomerBookingCount,
        findCustomerBookings
    };
}
