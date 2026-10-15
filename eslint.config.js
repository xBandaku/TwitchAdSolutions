const js = require('@eslint/js');
const globals = require('globals');
const { scripts, readScript, scriptNodes } = require('./tests/scripts');

module.exports = [
    { ignores: ['node_modules/**', 'release-artifact/**', 'playwright-report/**', 'test-results/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 2022 },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
        }
    },
    {
        files: ['eslint.config.js', 'tests/**/*.js'],
        languageOptions: { sourceType: 'commonjs', globals: globals.node }
    },
    {
        files: ['tests/browser.spec.js'],
        languageOptions: { globals: globals.browser }
    },
    {
        files: ['tests/*.js'],
        // Tests match literal indentation in source and workflow files.
        rules: { 'no-regex-spaces': 'off' }
    },
    ...scripts.map(({ file }) => ({
        files: [file],
        languageOptions: {
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...globals.worker,
                fetch: 'writable',
                pendingFetchRequests: 'writable',
                GM: 'readonly',
                GM_xmlHttpRequest: 'readonly',
                // declareOptions installs these names in both the page and serialized worker.
                ...Object.fromEntries(scriptNodes(readScript(file))
                    .filter(node => node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
                        && node.left.object.name === 'scope' && !node.left.computed)
                    .map(node => [node.left.property.name, 'writable']))
            }
        },
        ...(file.includes('ublock-origin') ? {
            processor: {
                preprocess: text => [text.replace(/^[^\r\n]+/, header => ' '.repeat(header.length))],
                postprocess: messages => messages.flat(),
                supportsAutofix: true
            }
        } : {})
    }))
];
