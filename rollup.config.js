import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { terser } from 'rollup-plugin-terser'
import copy from 'rollup-plugin-copy'
// If truthy, it expects all y-* dependencies in the upper directory.
// This is only necessary if you want to test and make changes to several repositories.
const localImports = process.env.LOCALIMPORTS

if (localImports) {
  console.info('Using local imports')
}

const customModules = new Set([
  'y-codemirror',
  'y-ace',
  'y-textarea',
  'y-quill',
  'y-dom',
  'y-prosemirror',
  'y-monaco'
])
/**
 * @type {Set<any>}
 */
const customLibModules = new Set([
  'lib0',
  'y-protocols'
])

// @ts-ignore We use this for debugging
const debugResolve = {
  resolveId (importee) {
    if (localImports) {
      if (importee === 'yjs') {
        return `${process.cwd()}/../yjs/src/index.js`
      }
      if (customModules.has(importee.split('/')[0])) {
        return `${process.cwd()}/../${importee}/src/${importee}.js`
      }
      if (customLibModules.has(importee.split('/')[0])) {
        return `${process.cwd()}/../${importee}`
      }
    }
    return null
  }
}
const minificationPlugins = process.env.PRODUCTION
  ? [terser({
    module: true,
    compress: {
      hoist_vars: true,
      module: true,
      passes: 1,
      pure_getters: true,
      unsafe_comps: true,
      unsafe_undefined: true
    },
    mangle: {
      toplevel: true
    }
  })]
  : []

const plugins = [
  debugResolve,
  nodeResolve({
    mainFields: ['module', 'browser', 'main']
  }),
  commonjs(),
  ...minificationPlugins,
  copy({
    targets: [
      { src: ['dist/y-ably.js','y-ably.js.map'], dest: '/media/ddl/MySSD/ably-collabrative-analysis/easy-bords/src/y-ably' }
    ]
  })
]

export default [
  {
    input: './demo/index.js',
    output: [{
      name: 'demo',
      file: 'dist/demo.js',
      format: 'iife',
      sourcemap: true
    }],
    plugins
  }, {
    input: './src/y-ably.js',
    external: id => /^(lib0|yjs|y-protocols|ably)/.test(id),
    output: [{
      name: 'y-ably',
      file: 'dist/y-ably.cjs',
      format: 'cjs',
      sourcemap: true
    }, 
    {
      name: 'y-ably',
      file: 'dist/y-ably.js',
      format: 'esm',
      sourcemap: true
    },
    ]
  }
]
