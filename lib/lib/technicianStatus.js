export function createTechnicianStatus(db) {
    async function recordTechnicianStatusUpdate({
        bookingNumber = '',
        technicianName = '',
        status = '',
        reportedTime = '',
        notes = '',
        callerPhone = ''
    }) {
        if (!status) {
            throw new Error(
                'Technician status is required.'
            );
        }

        const result = await db.query(
            `
            INSERT INTO public.technician_status_updates (
                booking_number,
                technician_name,
                status,
                reported_time,
                notes,
                caller_phone
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
                id,
                created_at
            `,
            [
                bookingNumber || null,
                technicianName || null,
                status,
                reportedTime || null,
                notes || null,
                callerPhone || null
            ]
        );

        return result.rows[0];
    }

    return {
        recordTechnicianStatusUpdate
    };
}
