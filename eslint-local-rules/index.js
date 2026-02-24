'use strict'

module.exports = {
  rules: {
    'no-v-t-directive': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Disallow the deprecated v-t directive. Use v-text="$t(\'key\')" instead.',
          category: 'Best Practices',
          recommended: true,
        },
        schema: [],
        messages: {
          noVT: 'The v-t directive is deprecated. Use v-text="$t(\'key\')" instead.',
        },
      },
      create (context) {
        return context.parserServices.defineTemplateBodyVisitor({
          "VAttribute[directive=true][key.name.name='t']" (node) {
            context.report({
              node,
              messageId: 'noVT',
            })
          },
        })
      },
    },
  },
}
