export function createBookingLookup(db) {
    function normalizePhone(phone) {
        return String(phone || '')
            .replace(/\D/g, '')
            .slice(-10);
    }

    async function findCustomerBookings(
        customerId,
        callerPhone
    ) {
        const phone = normalizePhone(callerPhone);

        if (!customerId && phone.length !== 10) {
            console.log(
                'Booking lookup skipped: no customer ID or valid phone number.'
            );

            return [];
        }

        const bookings = [];

        if (phone.length === 10) {
            try {
                const result = await db.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        octopus_booking_id,
                        booking_number,
                        NULL::text AS service_type,
                        booking_date,
                        arrival_window,
                        status,
                        NULL::numeric AS labor_hours,
                        NULL::integer AS technician_count,
                        invoice_total AS estimated_total,
                        COALESCE(invoice_total, final_total) AS final_total,
                        NULL::text AS special_requests
                    FROM public.booking_tracking
                    WHERE (
                          customer_phone_normalized = $1
                          OR $1 = ANY(
                              COALESCE(
                                  customer_phones_normalized,
                                  ARRAY[]::text[]
                              )
                          )
                      )
                      AND booking_date::date >= CURRENT_DATE
                      AND LOWER(COALESCE(status, '')) NOT IN (
                          'cancelled', 'canceled', 'completed',
                          'finished', 'failed'
                      )
                    ORDER BY booking_date ASC NULLS LAST, id DESC
                    LIMIT 10
                    `,
                    [phone]
                );

                bookings.push(...result.rows);
            } catch (error) {
                if (error?.code !== '42703') throw error;

                console.log(
                    'Phone booking cache columns are not installed yet; using customer booking history only.'
                );
            }
        }

        if (customerId) {
            const result = await db.query(
                `
                SELECT
                    id,
                    customer_id,
                    octopus_booking_id,
                    NULL::text AS booking_number,
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
                  AND booking_date::date >= CURRENT_DATE
                  AND LOWER(COALESCE(status, '')) NOT IN (
                      'cancelled', 'canceled', 'completed',
                      'finished', 'failed'
                  )
                ORDER BY booking_date ASC NULLS LAST, id DESC
                LIMIT 10
                `,
                [customerId]
            );

            bookings.push(...result.rows);
        }

        const uniqueBookings = Array.from(
            new Map(
                bookings.map(booking => [
                    String(
                        booking.octopus_booking_id ||
                        booking.booking_number ||
                        booking.id
                    ),
                    booking
                ])
            ).values()
        )
            .sort((left, right) =>
                new Date(left.booking_date).getTime() -
                new Date(right.booking_date).getTime()
            )
            .slice(0, 5);

        console.log(
            'Future bookings loaded for caller:',
            {
                customerId: customerId || null,
                phoneLast4:
                    phone.length === 10
                        ? phone.slice(-4)
                        : null,
                bookingCount: uniqueBookings.length,
                bookings: uniqueBookings.map(
                        booking => ({
                            booking_number:
                                booking.booking_number,
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

        return uniqueBookings;
    }

    async function findCustomerBookingCount(
        customerId,
        callerPhone
    ) {
        const bookings = await findCustomerBookings(
            customerId,
            callerPhone
        );

        return bookings.length;
    }

    return {
        findCustomerBookingCount,
        findCustomerBookings
    };
}
