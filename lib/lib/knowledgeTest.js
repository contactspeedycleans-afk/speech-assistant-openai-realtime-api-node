export function createKnowledgeTest({
    searchCompanyKnowledge
}) {

    async function testKnowledge(request, reply) {

        const query =
            request.query.q || '';

        const results =
            await searchCompanyKnowledge(query);

        return {
            success: true,
            query,
            results
        };
    }

    return {
        testKnowledge
    };
}
