module.exports = {
    "env": {
        "es6": true,
        "node": true,
        "jasmine": true
    },
    "extends": [
        "eslint:recommended"
    ],
    "globals": {
        "jest": true,
        "document": true
    },
    "parserOptions": {
        "ecmaVersion": 2018,
        "sourceType": "module"
    },
    "rules": {
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "unix"
        ],
        "quotes": [
            "error",
            "single"
        ],
        "semi": [
            "error",
            "always"
        ],
        "no-console": "off",
        "strict": "warn",
        "max-len": [ "warn", 120 ],
        "curly": "error",
        "arrow-parens": ["error", "always"],
        "camelcase": "error",
        "no-var": "error",
        "comma-dangle": "off"
    },
    "settings": {
        "import/resolver": {
            "node": {
                "moduleDirectory": [
                    "node_modules"
                ]
            }
        }
    }
}