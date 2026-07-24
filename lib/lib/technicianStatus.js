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

        // 👇 The rest of the original function goes here.
        // This includes the db.query(...) and the final:
        // return result.rows[0];
    }

    return {
        recordTechnicianStatusUpdate
    };
}
