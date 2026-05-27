'use strict'

const fs = require('fs')
const path = require('path')

/**
 * ESLint rule: no-undefined-vuex-mapping
 *
 * Detects `this.<name>` references in Vue components that are not defined
 * as data, computed, methods, props, or Vuex mappings (mapGetters, mapState,
 * mapActions, mapMutations).
 *
 * This catches bugs where a mapGetters/mapState name is renamed in the mapping
 * but the old name is still referenced in the component code.
 */

// Vue 2 built-in instance properties (prefixed with $)
const VUE_BUILTINS = new Set([
  '$data', '$props', '$el', '$options', '$parent', '$root', '$children',
  '$refs', '$slots', '$scopedSlots', '$isServer', '$attrs', '$listeners',
  '$watch', '$set', '$delete', '$on', '$once', '$off', '$emit',
  '$nextTick', '$forceUpdate', '$destroy', '$mount',
  '$router', '$route', '$store',
  // bootstrap-vue
  '$bvModal', '$bvToast', '$root',
  // vue-i18n
  '$t', '$tc', '$te', '$d', '$n', '$i18n',
  // vue-mq
  '$mq',
  // vue-cookies
  '$cookies',
])

/**
 * Cache for mixin property extraction to avoid re-reading files.
 * @type {Map<string, Set<string>>}
 */
const mixinCache = new Map()

/**
 * Cache for Pinia store property extraction to avoid re-reading files.
 * @type {Map<string, Set<string>>}
 */
const piniaStoreCache = new Map()

/**
 * Read a text file safely.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return null
  }
}

/**
 * Extract property names from a mixin file.
 * Handles: computed, data(), methods, props (both object and array form).
 * Uses brace-counting to handle nested braces in function bodies.
 *
 * @param {string} mixinPath - Absolute path to the mixin file
 * @returns {Set<string>} Set of property/method names
 */
function extractMixinProperties(mixinPath) {
  if (mixinCache.has(mixinPath)) {
    return mixinCache.get(mixinPath)
  }

  const names = new Set()

  try {
    const content = fs.readFileSync(mixinPath, 'utf-8')

    // Extract stores returned from setup(), which are available on components using the mixin.
    const setupMatch = content.match(/setup\s*\(\s*\)\s*\{/)
    if (setupMatch !== null) {
      const setupStartIdx = setupMatch.index + setupMatch[0].length
      const setupBlock = extractBracedBlock(content, setupStartIdx)
      if (setupBlock !== null) {
        const returnMatch = setupBlock.match(/return\s*\{([^}]+)\}/)
        if (returnMatch !== null) {
          const returnNameRegex = /(?:^|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*)?(?=,|$)/g
          let returnNameMatch
          while ((returnNameMatch = returnNameRegex.exec(returnMatch[1])) !== null) {
            names.add(returnNameMatch[1])
          }
        }
      }
    }

    // Extract computed property keys using brace-counting
    const computedMatch = content.match(/computed\s*:\s*\{/)
    if (computedMatch) {
      const startIdx = computedMatch.index + computedMatch[0].length
      const block = extractBracedBlock(content, startIdx)
      if (block !== null) {
        const keyRegex = /(?:^|,|\n)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|:)/g
        let keyMatch
        while ((keyMatch = keyRegex.exec(block)) !== null) {
          names.add(keyMatch[1])
        }
      }
    }

    // Extract data() return keys using brace-counting
    const dataMatch = content.match(/data\s*\(\s*\)\s*\{/)
    if (dataMatch) {
      const startIdx = dataMatch.index + dataMatch[0].length
      const block = extractBracedBlock(content, startIdx)
      if (block !== null) {
        // Find the return statement and extract keys from its object
        const returnMatch = block.match(/return\s*\{/)
        if (returnMatch) {
          const returnStartIdx = returnMatch.index + returnMatch[0].length
          const returnBlock = extractBracedBlock(block, returnStartIdx)
          const returnBlockWithoutComments = returnBlock !== null
            ? returnBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')
            : null
          const keyRegex = /(?:^|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g
          let keyMatch
          while (returnBlockWithoutComments !== null && (keyMatch = keyRegex.exec(returnBlockWithoutComments)) !== null) {
            names.add(keyMatch[1])
          }
        }
      }
    }

    // Extract methods keys using brace-counting
    const methodsMatch = content.match(/methods\s*:\s*\{/)
    if (methodsMatch) {
      const startIdx = methodsMatch.index + methodsMatch[0].length
      const block = extractBracedBlock(content, startIdx)
      if (block !== null) {
        const keyRegex = /(?:^|,|\n)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g
        let keyMatch
        while ((keyMatch = keyRegex.exec(block)) !== null) {
          names.add(keyMatch[1])
        }
      }
    }

    // Extract props keys (object form) using brace-counting
    const propsObjMatch = content.match(/props\s*:\s*\{/)
    if (propsObjMatch) {
      const startIdx = propsObjMatch.index + propsObjMatch[0].length
      const block = extractBracedBlock(content, startIdx)
      if (block !== null) {
        const keyRegex = /(?:^|,|\n)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g
        let keyMatch
        while ((keyMatch = keyRegex.exec(block)) !== null) {
          names.add(keyMatch[1])
        }
      }
    }

    // Extract props keys (array form)
    const propsArrRegex = /props\s*:\s*\[([^\]]+)\]/g
    while ((match = propsArrRegex.exec(content)) !== null) {
      const propsBlock = match[1]
      const keyRegex = /(?:^|,)\s*['"]([a-zA-Z_$][a-zA-Z0-9_$]*)['"]/g
      let keyMatch
      while ((keyMatch = keyRegex.exec(propsBlock)) !== null) {
        names.add(keyMatch[1])
      }
    }
  } catch (e) {
    // If we can't read the file, just skip it
  }

  mixinCache.set(mixinPath, names)
  return names
}

/**
 * Extract the content inside a braced block starting at the given index.
 * Uses brace-counting to handle nested braces.
 *
 * @param {string} content - The full file content
 * @param {number} startIdx - Index after the opening brace
 * @returns {string|null} The content inside the braces, or null
 */
function extractBracedBlock(content, startIdx) {
  let depth = 1
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return content.slice(startIdx, i)
      }
    }
  }
  return null
}

/**
 * Resolve an import path relative to a file.
 *
 * @param {string} importerPath - Path of the file doing the importing
 * @param {string} importSpec - The import specifier (e.g., './media-card-common')
 * @returns {string|null} Resolved file path or null
 */
function resolveImport(importerPath, importSpec) {
  // Skip node_modules imports
  if (!importSpec.startsWith('.')) {
    return null
  }

  const importerDir = path.dirname(importerPath)
  let resolved = path.resolve(importerDir, importSpec)

  // Try common extensions
  const extensions = ['', '.js', '.vue']
  for (const ext of extensions) {
    const tryPath = resolved + ext
    if (fs.existsSync(tryPath)) {
      return tryPath
    }
    // Try index.js in directory
    if (fs.existsSync(tryPath + '/index.js')) {
      return tryPath + '/index.js'
    }
  }

  return null
}

/**
 * Extract a static property name from an object property key.
 *
 * @param {import('estree').Property|import('estree').Node} prop
 * @returns {string|null}
 */
function getStaticPropertyName(prop) {
  if (prop.type !== 'Property' && prop.type !== 'ObjectMethod') {
    return null
  }

  if (prop.key.type === 'Identifier') {
    return prop.key.name
  }

  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') {
    return prop.key.value
  }

  return null
}

/**
 * Extract local property names from an ObjectExpression.
 *
 * @param {import('estree').ObjectExpression|null} node
 * @returns {string[]}
 */
function extractStaticObjectPropertyKeys(node) {
  if (node === null || node.type !== 'ObjectExpression') {
    return []
  }

  const names = []
  for (const prop of node.properties) {
    const propName = getStaticPropertyName(prop)
    if (propName !== null) {
      names.push(propName)
    }
  }

  return names
}

/**
 * Extract property keys from a text block that contains an object body.
 * This is intentionally conservative and supports the store style used in this project.
 *
 * @param {string} block
 * @returns {Set<string>}
 */
function extractObjectBodyKeysFromText(block) {
  const names = new Set()
  const keyRegex = /(?:^|,|\n)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|:)/g
  let keyMatch

  while ((keyMatch = keyRegex.exec(block)) !== null) {
    names.add(keyMatch[1])
  }

  return names
}

/**
 * Extract Pinia store members from a defineStore options file.
 * Handles state, getters, and actions in object-style stores.
 *
 * @param {string} storePath
 * @returns {Set<string>}
 */
function extractPiniaStoreProperties(storePath) {
  if (piniaStoreCache.has(storePath)) {
    return piniaStoreCache.get(storePath)
  }

  const names = new Set()

  try {
    const content = fs.readFileSync(storePath, 'utf-8')

    let stateMatch = content.match(/state\s*:\s*\(\s*\)\s*=>\s*\(\s*\{/)
    if (stateMatch === null) {
      stateMatch = content.match(/state\s*:\s*\{/)
    }

    if (stateMatch !== null) {
      const startIdx = stateMatch.index + stateMatch[0].length
      const stateBlock = extractBracedBlock(content, startIdx)
      if (stateBlock !== null) {
        for (const name of extractObjectBodyKeysFromText(stateBlock)) {
          names.add(name)
        }
      }
    }

    for (const sectionName of ['getters', 'actions']) {
      const sectionMatch = content.match(new RegExp(sectionName + '\\s*:\\s*\\{'))
      if (sectionMatch === null) {
        continue
      }

      const startIdx = sectionMatch.index + sectionMatch[0].length
      const sectionBlock = extractBracedBlock(content, startIdx)
      if (sectionBlock === null) {
        continue
      }

      for (const name of extractObjectBodyKeysFromText(sectionBlock)) {
        names.add(name)
      }
    }
  } catch (e) {
    // If we can't read the store, skip nested validation for it.
  }

  piniaStoreCache.set(storePath, names)
  return names
}

/**
 * Detect whether a file is an object-style Pinia store.
 *
 * @param {string} sourceCode
 * @returns {boolean}
 */
function isPiniaDefineStoreFile(sourceCode) {
  return /defineStore\s*\(/.test(sourceCode)
}

/**
 * Collect properties coming from object spreads such as `...BaseList.actions`.
 *
 * @param {string} sourceCode
 * @param {Map<string, string>} importPathByName
 * @returns {Set<string>}
 */
function extractSpreadSourceProperties(sourceCode, importPathByName) {
  const names = new Set()
  const spreadRegex = /\.\.\.([a-zA-Z_$][a-zA-Z0-9_$]*)\.(state|getters|actions)/g
  let spreadMatch

  while ((spreadMatch = spreadRegex.exec(sourceCode)) !== null) {
    const importName = spreadMatch[1]
    const importPath = importPathByName.get(importName)

    if (importPath === undefined) {
      continue
    }

    const importedProperties = extractPiniaStoreProperties(importPath)
    for (const prop of importedProperties) {
      names.add(prop)
    }
  }

  return names
}

/**
 * Extract identifiers referenced in object spreads such as `...useListBase.state`.
 *
 * @param {string} sourceCode
 * @returns {Set<string>}
 */
function extractSpreadSourceNames(sourceCode) {
  const names = new Set()
  const spreadRegex = /\.\.\.([a-zA-Z_$][a-zA-Z0-9_$]*)\.(state|getters|actions)/g
  let spreadMatch

  while ((spreadMatch = spreadRegex.exec(sourceCode)) !== null) {
    names.add(spreadMatch[1])
  }

  return names
}

/**
 * Extract mixin names from import statements and the mixins array.
 *
 * @param {string} sourceCode - The source code of the file
 * @param {string} filePath - The absolute path of the file
 * @returns {string[]} Array of resolved mixin file paths
 */
function extractMixinFiles(sourceCode, filePath) {
  const mixinPaths = []

  // Find import statements and resolve mixin imports
  const importRegex = /import\s+\w+\s+from\s+['"]([^'"]+)['"]/g
  let match
  const importMap = new Map() // name -> resolved path

  while ((match = importRegex.exec(sourceCode)) !== null) {
    const resolved = resolveImport(filePath, match[1])
    if (resolved) {
      // Extract the imported name (handle default and named imports)
      const importSpec = match[0]
      const defaultMatch = importSpec.match(/import\s+(\w+)\s+from/)
      if (defaultMatch) {
        importMap.set(defaultMatch[1], resolved)
      }
    }
  }

  // Find mixins: [MixinA, MixinB] in the component definition
  const mixinsRegex = /mixins\s*:\s*\[([^\]]+)\]/
  const mixinsMatch = sourceCode.match(mixinsRegex)
  if (mixinsMatch) {
    const mixinsBlock = mixinsMatch[1]
    const nameRegex = /(?:^|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*/g
    let nameMatch
    while ((nameMatch = nameRegex.exec(mixinsBlock)) !== null) {
      const mixinName = nameMatch[1].trim()
      if (importMap.has(mixinName)) {
        mixinPaths.push(importMap.get(mixinName))
      }
    }
  }

  return mixinPaths
}

/**
 * Recursively extract all property names from mixins (including nested mixins).
 *
 * @param {string[]} mixinPaths - Array of mixin file paths
 * @param {Set<string>} collected - Set to collect names into
 * @param {Set<string>} visited - Set to track visited files (avoid cycles)
 */
function collectMixinProperties(mixinPaths, collected, visited) {
  for (const mixinPath of mixinPaths) {
    if (visited.has(mixinPath)) {
      continue
    }
    visited.add(mixinPath)

    // Extract properties from this mixin
    const props = extractMixinProperties(mixinPath)
    for (const prop of props) {
      collected.add(prop)
    }

    // Check if this mixin has its own mixins
    try {
      const content = fs.readFileSync(mixinPath, 'utf-8')
      const nestedMixinPaths = extractMixinFiles(content, mixinPath)
      collectMixinProperties(nestedMixinPaths, collected, visited)
    } catch (e) {
      // Skip if we can't read the file
    }
  }
}

// Names of the Vuex mapping helpers
const MAP_FUNCTIONS = new Set([
  'mapGetters', 'mapState', 'mapActions', 'mapMutations',
])

/**
 * Extract local property names from a map* call.
 * Handles:
 *   mapFn({ localName: 'namespace/getterName', ... })
 *   mapFn(['name1', 'name2'])
 *   mapFn('namespace', ['name1', 'name2'])
 *   mapFn('namespace', { localName: 'getterName' })
 *
 * @param {import('estree').CallExpression} node
 * @returns {string[]}
 */
function extractMapNames(node) {
  const names = []

  if (node.arguments.length === 0) {
    return names
  }

  let mappingArg = null

  if (node.arguments.length === 1) {
    mappingArg = node.arguments[0]
  } else if (node.arguments.length === 2) {
    // First arg is namespace string, second is array or object
    mappingArg = node.arguments[1]
  }

  if (mappingArg === null) {
    return names
  }

  if (mappingArg.type === 'ObjectExpression') {
    for (const prop of mappingArg.properties) {
      if (prop.type === 'Property' && prop.key.type === 'Identifier') {
        names.push(prop.key.name)
      }
    }
  } else if (mappingArg.type === 'ArrayExpression') {
    for (const element of mappingArg.elements) {
      if (element !== null && element.type === 'Literal' && typeof element.value === 'string') {
        names.push(element.value)
      }
    }
  }

  return names
}

/**
 * Check if a node is a map* call inside a spread element within an object.
 * Pattern: `{ ...mapGetters(...) }`
 *
 * @param {import('estree').CallExpression} node
 * @returns {boolean}
 */
function isSpreadMapCall(node) {
  return (
    node.parent !== null &&
    node.parent.type === 'SpreadElement' &&
    node.parent.parent !== null &&
    node.parent.parent.type === 'ObjectExpression'
  )
}

/**
 * Extract property name keys from an ObjectExpression (for computed, methods, props objects).
 * Excludes SpreadElement nodes (which contain map* calls).
 *
 * @param {import('estree').ObjectExpression|null} node
 * @returns {string[]}
 */
function extractObjectPropertyKeys(node) {
  return extractStaticObjectPropertyKeys(node)
}

/**
 * Extract property names from a data() function's return statement.
 * Handles `data() { return { key1: ..., key2: ... } }`
 *
 * @param {import('estree').FunctionExpression|import('estree').Property|null} fnNode
 * @returns {string[]}
 */
function extractDataReturnKeys(fnNode) {
  if (fnNode === null) {
    return []
  }

  const body = fnNode.body
  if (body.type !== 'BlockStatement') {
    return []
  }

  // Find the return statement
  for (const stmt of body.body) {
    if (stmt.type === 'ReturnStatement' && stmt.argument !== null && stmt.argument.type === 'ObjectExpression') {
      return extractObjectPropertyKeys(stmt.argument)
    }
  }

  return []
}

/**
 * Calculate the Levenshtein distance between two strings.
 * Used to suggest similar names in error messages.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshteinDistance(a, b) {
  const matrix = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Find the closest matching name from a set of candidates.
 *
 * @param {string} target
 * @param {Set<string>} candidates
 * @param {number} maxDistance
 * @returns {string|null}
 */
function findClosestName(target, candidates, maxDistance = 3) {
  let best = null
  let bestDistance = maxDistance + 1

  for (const candidate of candidates) {
    const dist = levenshteinDistance(target, candidate)
    if (dist < bestDistance) {
      bestDistance = dist
      best = candidate
    }
  }

  return bestDistance <= maxDistance ? best : null
}

/**
 * Build an import map for locally imported identifiers.
 * Supports default and named imports used by the project Pinia stores.
 *
 * @param {import('estree').Program} programNode
 * @param {string} filePath
 * @returns {Map<string, string>}
 */
function buildImportPathMap(programNode, filePath) {
  const importPathByName = new Map()

  for (const statement of programNode.body) {
    if (statement.type !== 'ImportDeclaration' || typeof statement.source.value !== 'string') {
      continue
    }

    const resolvedPath = resolveImport(filePath, statement.source.value)
    if (resolvedPath === null) {
      continue
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportDefaultSpecifier' ||
        specifier.type === 'ImportSpecifier'
      ) {
        importPathByName.set(specifier.local.name, resolvedPath)
      }
    }
  }

  return importPathByName
}

/**
 * Build an import map from raw source text.
 * Supports default and named imports used by project store modules.
 *
 * @param {string} sourceCode
 * @param {string} filePath
 * @returns {Map<string, string>}
 */
function extractImportPathMapFromSource(sourceCode, filePath) {
  const importPathByName = new Map()
  const importRegex = /import\s+([^'"\n]+)\s+from\s+['"]([^'"]+)['"]/g
  let importMatch

  while ((importMatch = importRegex.exec(sourceCode)) !== null) {
    const resolvedPath = resolveImport(filePath, importMatch[2])
    if (resolvedPath === null) {
      continue
    }

    const importClause = importMatch[1].trim()
    const defaultMatch = importClause.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/)
    if (defaultMatch !== null) {
      importPathByName.set(defaultMatch[1], resolvedPath)
    }

    const namedMatch = importClause.match(/\{([^}]+)\}/)
    if (namedMatch === null) {
      continue
    }

    const namedImports = namedMatch[1].split(',')
    for (const namedImport of namedImports) {
      const parts = namedImport.trim().split(/\s+as\s+/)
      const localName = (parts.length === 2 ? parts[1] : parts[0]).trim()
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
        importPathByName.set(localName, resolvedPath)
      }
    }
  }

  return importPathByName
}

/**
 * Extract Pinia stores returned from a Vue setup() function.
 * Pattern:
 *   const brands = useBrands()
 *   return { brands }
 *
 * @param {import('estree').FunctionExpression|import('estree').ArrowFunctionExpression} setupFn
 * @param {Map<string, string>} importPathByName
 * @returns {Map<string, Set<string>>}
 */
function extractReturnedPiniaStores(setupFn, importPathByName) {
  const piniaFactoryByLocalName = new Map()
  const piniaPropertiesByReturnedName = new Map()

  if (setupFn.body.type !== 'BlockStatement') {
    return piniaPropertiesByReturnedName
  }

  for (const statement of setupFn.body.body) {
    if (statement.type !== 'VariableDeclaration') {
      continue
    }

    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== 'Identifier' ||
        declaration.init === null ||
        declaration.init.type !== 'CallExpression' ||
        declaration.init.callee.type !== 'Identifier'
      ) {
        continue
      }

      piniaFactoryByLocalName.set(declaration.id.name, declaration.init.callee.name)
    }
  }

  for (const statement of setupFn.body.body) {
    if (
      statement.type !== 'ReturnStatement' ||
      statement.argument === null ||
      statement.argument.type !== 'ObjectExpression'
    ) {
      continue
    }

    for (const prop of statement.argument.properties) {
      if (prop.type !== 'Property') {
        continue
      }

      const returnedName = getStaticPropertyName(prop)
      if (returnedName === null || prop.value.type !== 'Identifier') {
        continue
      }

      const factoryName = piniaFactoryByLocalName.get(prop.value.name)
      if (factoryName === undefined) {
        continue
      }

      const storePath = importPathByName.get(factoryName)
      if (storePath === undefined) {
        continue
      }

      const storeProperties = extractPiniaStoreProperties(storePath)
      const storeSourceCode = readTextFile(storePath)
      const storeImportPathByName = storeSourceCode !== null
        ? extractImportPathMapFromSource(storeSourceCode, storePath)
        : new Map()
      const spreadSourceNames = storeSourceCode !== null
        ? extractSpreadSourceNames(storeSourceCode)
        : new Set()

      for (const spreadSourceName of spreadSourceNames) {
        const spreadSourcePath = storeImportPathByName.get(spreadSourceName)
        if (spreadSourcePath === undefined) {
          continue
        }

        for (const spreadSourceProperty of extractPiniaStoreProperties(spreadSourcePath)) {
          storeProperties.add(spreadSourceProperty)
        }
      }

      if (storeProperties.size > 0) {
        piniaPropertiesByReturnedName.set(returnedName, storeProperties)
      }
    }
  }

  return piniaPropertiesByReturnedName
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `this.<name>` references that are not defined as data, computed, methods, props, or Vuex mappings',
      category: 'Possible Errors',
      recommended: true,
    },
    schema: [{
      type: 'object',
      properties: {
        allowed: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
        },
      },
      additionalProperties: false,
    }],
    messages: {
      undefinedProperty: "'{{name}}' is not defined as a computed property, data, method, prop, or Vuex mapping. {{suggestion}}",
      suggestion: "Did you mean '{{suggestedName}}'?",
    },
  },

  create(context) {
    const options = context.options[0] || {}
    const allowedNames = new Set(options.allowed || [])

    // Names defined in the component (data, computed, methods, props, map*)
    const definedNames = new Set()

    /**
     * Pinia store properties exposed on `this` by setup() return values.
     * @type {Map<string, Set<string>>}
     */
    const piniaStorePropertiesByName = new Map()

    // Used names (from this.X expressions)
    const usedNames = new Map() // name -> [nodes]

    /**
     * Used nested Pinia names (from this.store.property expressions).
     * @type {Map<string, {storeName: string, propertyName: string, nodes: import('estree').Node[]}>}
     */
    const usedPiniaNestedNames = new Map()

    /**
     * Check if the node is inside the component's export default object.
     * We only care about `this` references inside the component definition.
     */
    function isInsideComponentExport(node) {
      let current = node
      while (current !== null) {
        if (
          current.type === 'ExportDefaultDeclaration' ||
          current.type === 'ExportNamedDeclaration'
        ) {
          return true
        }
        current = current.parent
      }
      return false
    }

    return {
      // ---- Collect defined names ----

      // Detect spread map* calls: ...mapGetters({ ... })
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          MAP_FUNCTIONS.has(node.callee.name) &&
          isSpreadMapCall(node)
        ) {
          const names = extractMapNames(node)
          for (const name of names) {
            definedNames.add(name)
          }
        }
      },

      // Detect the component's export default object
      'ExportDefaultDeclaration > ObjectExpression'(node) {
        let dataFn = null
        let computedObj = null
        let methodsObj = null
        let propsObj = null
        let setupFn = null
        let stateObj = null
        let gettersObj = null
        let actionsObj = null

        for (const prop of node.properties) {
          const keyName = getStaticPropertyName(prop)
          if (keyName === null) {
            continue
          }

          if (keyName === 'data' && prop.type === 'ObjectMethod') {
            dataFn = prop
          } else if (keyName === 'data' && prop.value.type === 'FunctionExpression') {
            dataFn = prop.value
          } else if (keyName === 'computed' && prop.value.type === 'ObjectExpression') {
            computedObj = prop.value
          } else if (keyName === 'methods' && prop.value.type === 'ObjectExpression') {
            methodsObj = prop.value
          } else if (keyName === 'state' && prop.value.type === 'ObjectExpression') {
            stateObj = prop.value
          } else if (keyName === 'getters' && prop.value.type === 'ObjectExpression') {
            gettersObj = prop.value
          } else if (keyName === 'actions' && prop.value.type === 'ObjectExpression') {
            actionsObj = prop.value
          } else if (keyName === 'props' && prop.value.type === 'ObjectExpression') {
            propsObj = prop.value
          } else if (keyName === 'props' && prop.value.type === 'ArrayExpression') {
            // props: ['propName1', 'propName2']
            for (const element of prop.value.elements) {
              if (element !== null && element.type === 'Literal' && typeof element.value === 'string') {
                definedNames.add(element.value)
              }
            }
          } else if (
            keyName === 'setup' &&
            (
              prop.value.type === 'FunctionExpression' ||
              prop.value.type === 'ArrowFunctionExpression'
            )
          ) {
            setupFn = prop.value
          }
        }

        // Extract data() return keys
        if (dataFn !== null) {
          const dataKeys = extractDataReturnKeys(dataFn)
          for (const key of dataKeys) {
            definedNames.add(key)
          }
        }

        // Extract computed keys (excluding spread map* calls)
        if (computedObj !== null) {
          const computedKeys = extractObjectPropertyKeys(computedObj)
          for (const key of computedKeys) {
            definedNames.add(key)
          }
        }

        // Extract methods keys (excluding spread map* calls)
        if (methodsObj !== null) {
          const methodKeys = extractObjectPropertyKeys(methodsObj)
          for (const key of methodKeys) {
            definedNames.add(key)
          }
        }

        if (stateObj !== null) {
          const stateKeys = extractObjectPropertyKeys(stateObj)
          for (const key of stateKeys) {
            definedNames.add(key)
          }
        }

        if (gettersObj !== null) {
          const getterKeys = extractObjectPropertyKeys(gettersObj)
          for (const key of getterKeys) {
            definedNames.add(key)
          }
        }

        if (actionsObj !== null) {
          const actionKeys = extractObjectPropertyKeys(actionsObj)
          for (const key of actionKeys) {
            definedNames.add(key)
          }
        }

        // Extract props keys (object form)
        if (propsObj !== null) {
          const propKeys = extractObjectPropertyKeys(propsObj)
          for (const key of propKeys) {
            definedNames.add(key)
          }
        }

        // Extract mixin properties
        const sourceCode = context.getSourceCode().text
        const filePath = context.getFilename()
        // DEBUG: Log file path and source code for debugging
        // console.error('DEBUG filePath:', filePath)
        // console.error('DEBUG sourceCode length:', sourceCode.length)
        // console.error('DEBUG has mixins:', sourceCode.includes('mixins:'))
        const mixinPaths = extractMixinFiles(sourceCode, filePath)
        // console.error('DEBUG mixinPaths:', mixinPaths)
        const collectedMixinProps = new Set()
        const visitedMixins = new Set()
        collectMixinProperties(mixinPaths, collectedMixinProps, visitedMixins)
        // console.error('DEBUG collectedMixinProps:', [...collectedMixinProps])
        for (const prop of collectedMixinProps) {
          definedNames.add(prop)
        }

        if (setupFn !== null) {
          const programNode = context.getSourceCode().ast
          const importPathByName = buildImportPathMap(programNode, filePath)
          const returnedPiniaStores = extractReturnedPiniaStores(setupFn, importPathByName)

          for (const [storeName, storeProperties] of returnedPiniaStores) {
            definedNames.add(storeName)
            piniaStorePropertiesByName.set(storeName, storeProperties)
          }
        }
      },

      'NewExpression[callee.name="Vue"] > ObjectExpression'(node) {
        let dataFn = null
        let computedObj = null
        let methodsObj = null
        let propsObj = null

        for (const prop of node.properties) {
          const keyName = getStaticPropertyName(prop)
          if (keyName === null) {
            continue
          }

          if (keyName === 'data' && prop.type === 'ObjectMethod') {
            dataFn = prop
          } else if (keyName === 'data' && prop.value.type === 'FunctionExpression') {
            dataFn = prop.value
          } else if (keyName === 'computed' && prop.value.type === 'ObjectExpression') {
            computedObj = prop.value
          } else if (keyName === 'methods' && prop.value.type === 'ObjectExpression') {
            methodsObj = prop.value
          } else if (keyName === 'props' && prop.value.type === 'ObjectExpression') {
            propsObj = prop.value
          } else if (keyName === 'props' && prop.value.type === 'ArrayExpression') {
            for (const element of prop.value.elements) {
              if (element !== null && element.type === 'Literal' && typeof element.value === 'string') {
                definedNames.add(element.value)
              }
            }
          }
        }

        if (dataFn !== null) {
          const dataKeys = extractDataReturnKeys(dataFn)
          for (const key of dataKeys) {
            definedNames.add(key)
          }
        }

        if (computedObj !== null) {
          const computedKeys = extractObjectPropertyKeys(computedObj)
          for (const key of computedKeys) {
            definedNames.add(key)
          }
        }

        if (methodsObj !== null) {
          const methodKeys = extractObjectPropertyKeys(methodsObj)
          for (const key of methodKeys) {
            definedNames.add(key)
          }
        }

        if (propsObj !== null) {
          const propKeys = extractObjectPropertyKeys(propsObj)
          for (const key of propKeys) {
            definedNames.add(key)
          }
        }
      },

      'Program'(node) {
        const sourceCode = context.getSourceCode().text
        const filePath = context.getFilename()
        const importPathByName = buildImportPathMap(node, filePath)

        const spreadSourceProperties = extractSpreadSourceProperties(sourceCode, importPathByName)
        for (const prop of spreadSourceProperties) {
          definedNames.add(prop)
        }

        if (!isPiniaDefineStoreFile(sourceCode)) {
          return
        }

        const storeProperties = extractPiniaStoreProperties(filePath)
        for (const prop of storeProperties) {
          definedNames.add(prop)
        }
      },

      // ---- Collect this.X usages ----

      // Handle Vue SFC <script setup> syntax
      'ExportDefaultDeclaration > ObjectExpression > Property[key.name="setup"]'(node) {
        // In <script setup>, properties are implicitly available in the template
        // We don't need to do anything special here as they're auto-exposed
      },

      MemberExpression(node) {
        if (
          node.object.type === 'MemberExpression' &&
          node.object.object.type === 'ThisExpression' &&
          node.object.property.type === 'Identifier' &&
          node.object.computed === false &&
          node.property.type === 'Identifier' &&
          node.computed === false
        ) {
          const storeName = node.object.property.name
          const propertyName = node.property.name

          if (piniaStorePropertiesByName.has(storeName)) {
            const key = storeName + '.' + propertyName

            if (!usedPiniaNestedNames.has(key)) {
              usedPiniaNestedNames.set(key, {
                storeName,
                propertyName,
                nodes: [],
              })
            }

            usedPiniaNestedNames.get(key).nodes.push(node)
          }
        }

        // Only check this.something (not this.something.else or this[something])
        if (
          node.object.type === 'ThisExpression' &&
          node.property.type === 'Identifier' &&
          !node.computed
        ) {
          const memberName = node.property.name

          // Skip Vue built-in properties (prefixed with $)
          if (memberName.startsWith('$') || VUE_BUILTINS.has(memberName)) {
            return
          }

          // Skip if it's part of an assignment (this.x = ...)
          // We only want to flag reads, not writes
          if (
            node.parent !== null &&
            node.parent.type === 'AssignmentExpression' &&
            node.parent.left === node
          ) {
            return
          }

          // Skip if it's a property access on the result (e.g., this.user.name)
          // Only check the first level after `this`
          if (
            node.parent !== null &&
            node.parent.type === 'MemberExpression' &&
            node.parent.object === node
          ) {
            // This is this.X.Y — record X usage but note it's intermediate
            // We still record it since X itself must be defined
          }

          if (!usedNames.has(memberName)) {
            usedNames.set(memberName, [])
          }
          usedNames.get(memberName).push(node)
        }
      },

      // ---- Template body visitor: handle bare identifiers in templates ----
      // In templates, component properties are accessed without `this.`
      // e.g., `v-if="loggedIn"` instead of `v-if="this.loggedIn"`

      // ---- Report undefined names ----

      'Program:exit'() {
        // Collect all known names (defined + allowed + Vue builtins)
        const allKnown = new Set([
          ...definedNames,
          ...allowedNames,
          ...VUE_BUILTINS,
        ])

        // Collect names from map* calls specifically for suggestions
        const mappedNames = new Set()
        // We need to re-collect mapped names... but we already have them in definedNames.
        // For suggestions, we filter definedNames to those that came from map* calls.
        // However, we don't have a separate tracker. Let's use definedNames as the basis.

        for (const [name, nodes] of usedNames) {
          if (!allKnown.has(name) && !definedNames.has(name)) {
            // Find closest suggestion from defined names
            const suggestion = findClosestName(name, definedNames, 4)

            for (const node of nodes) {
              if (suggestion !== null) {
                context.report({
                  node,
                  messageId: 'undefinedProperty',
                  data: {
                    name,
                    suggestion: `Did you mean '${suggestion}'?`,
                  },
                })
              } else {
                context.report({
                  node,
                  messageId: 'undefinedProperty',
                  data: {
                    name,
                    suggestion: 'If this comes from a mixin, add it to the `allowed` option.',
                  },
                })
              }
            }
          }
        }

        for (const [name, usage] of usedPiniaNestedNames) {
          const knownStoreProperties = piniaStorePropertiesByName.get(usage.storeName)

          if (knownStoreProperties === undefined || knownStoreProperties.has(usage.propertyName)) {
            continue
          }

          const suggestion = findClosestName(usage.propertyName, knownStoreProperties, 4)

          for (const node of usage.nodes) {
            context.report({
              node,
              messageId: 'undefinedProperty',
              data: {
                name,
                suggestion: suggestion !== null
                  ? `Did you mean '${usage.storeName}.${suggestion}'?`
                  : 'This Pinia store property is not defined in state, getters, or actions.',
              },
            })
          }
        }
      },
    }
  },
}
