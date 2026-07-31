// eslint.config.js

export default [
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                console: "readonly",
                window: "readonly",
                document: "readonly"
            }
        },
        rules: {
            "space-before-function-paren": ["error", "always"],
            "func-call-spacing": ["error", "never"],

            "quotes": ["error", "single", { "avoidEscape": true }],
            "semi": ["error", "always"],

            "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
            "no-undef": "error",
            "no-redeclare": "error",
            "no-unreachable": "error",
            "no-debugger": "error",
            "no-dupe-keys": "error",
            "no-fallthrough": "error",
            "eqeqeq": ["error", "always"],
            "no-var": "error",
            "prefer-const": ["error", { "destructuring": "all" }],

            "indent": "off",
            "brace-style": "off",
            "keyword-spacing": "off",
            "nonblock-statement-body-position": "off",
            "curly": "off",
            "object-curly-spacing": "off",
            "comma-dangle": "off",
            "arrow-parens": "off"
        }
    },
    {
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/.cache/**"
        ]
    }
];