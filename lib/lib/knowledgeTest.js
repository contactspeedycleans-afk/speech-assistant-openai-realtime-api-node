export function createKnowledgeTest({
    searchCompanyKnowledge
}) {
    async function testKnowledge(request, reply) {
        const query =
            request.query?.q || '';

        if (!query.trim()) {
            return reply.code(400).send({
                success: false,
                error: 'Query parameter q is required.'
            });
        }

        try {
            const results =
                await searchCompanyKnowledge(query);

            return reply.send({
                success: true,
                query,
                count: results.length,
                results
            });
        } catch (error) {
            console.error(
                'DEV knowledge test failed:',
                error
            );

            return reply.code(500).send({
                success: false,
                error:
                    error?.message ||
                    'Knowledge search failed.'
            });
        }
    }

    return {
        testKnowledge
    };
}
