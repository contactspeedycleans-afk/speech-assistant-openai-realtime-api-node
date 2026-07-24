export function createKnowledgeSearch(db) {
    async function searchCompanyKnowledge(query) {
        if (!query || !String(query).trim()) {
            return [];
        }

        console.log(
            'Searching company knowledge for:',
            query
        );

        const result = await db.query(
            `
            SELECT *
            FROM public.search_knowledge_base($1, 5)
            `,
            [String(query).trim()]
        );

        console.log(
            'Knowledge results found:',
            result.rows.length
        );

        return result.rows;
    }

    return {
        searchCompanyKnowledge
    };
}
