import {
  NewlineType,
  type SimpleExpressionNode,
  isSimpleIdentifier,
} from '@vue/compiler-core'
import type { CodegenContext } from '../generate'
import {
  IRDynamicPropsKind,
  type IRProp,
  type SetDynamicPropsIRNode,
  type SetInheritAttrsIRNode,
  type SetPropIRNode,
  type VaporHelper,
} from '../ir'
import { genExpression } from './expression'
import {
  type CodeFragment,
  DELIMITERS_ARRAY,
  DELIMITERS_OBJECT,
  NEWLINE,
  genCall,
  genMulti,
} from './utils'
import {
  attributeCache,
  canSetValueDirectly,
  isArray,
  isHTMLGlobalAttr,
  isHTMLTag,
  isMathMLGlobalAttr,
  isMathMLTag,
  isSVGTag,
  isSvgGlobalAttr,
  shouldSetAsAttr,
  toHandlerKey,
} from '@vue/shared'

// only the static key prop will reach here
export function genSetProp(
  oper: SetPropIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper } = context
  const {
    prop: { key, values, modifier },
    tag,
  } = oper
  const { helperName, omitKey } = getRuntimeHelper(tag, key.content, modifier)
  const propValue = genPropValue(values, context)
  const { prevValueName, shouldWrapInParentheses } = processPropValues(
    context,
    helperName,
    [propValue],
  )
  return [
    NEWLINE,
    ...(prevValueName
      ? [shouldWrapInParentheses ? `(` : undefined, `${prevValueName} = `]
      : []),
    ...genCall(
      [vaporHelper(helperName), null],
      `n${oper.element}`,
      omitKey ? false : genExpression(key, context),
      ...(prevValueName ? [`${prevValueName}`] : []),
      propValue,
      // only `setClass` and `setStyle` need merge inherit attr
      oper.root && (helperName === 'setClass' || helperName === 'setStyle')
        ? 'true'
        : undefined,
    ),
    ...(prevValueName && shouldWrapInParentheses ? [`)`] : []),
  ]
}

// dynamic key props and v-bind="{}" will reach here
export function genDynamicProps(
  oper: SetDynamicPropsIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper } = context
  const values = oper.props.map(props =>
    Array.isArray(props)
      ? genLiteralObjectProps(props, context) // static and dynamic arg props
      : props.kind === IRDynamicPropsKind.ATTRIBUTE
        ? genLiteralObjectProps([props], context) // dynamic arg props
        : genExpression(props.value, context),
  ) // v-bind=""
  const { prevValueName, shouldWrapInParentheses } = processPropValues(
    context,
    'setDynamicProps',
    values,
  )
  return [
    NEWLINE,
    ...(prevValueName
      ? [shouldWrapInParentheses ? `(` : undefined, `${prevValueName} = `]
      : []),
    ...genCall(
      vaporHelper('setDynamicProps'),
      `n${oper.element}`,
      ...(prevValueName ? [`${prevValueName}`] : []),
      genMulti(DELIMITERS_ARRAY, ...values),
      oper.root && 'true',
    ),
    ...(prevValueName && shouldWrapInParentheses ? [`)`] : []),
  ]
}

function genLiteralObjectProps(
  props: IRProp[],
  context: CodegenContext,
): CodeFragment[] {
  return genMulti(
    DELIMITERS_OBJECT,
    ...props.map(prop => [
      ...genPropKey(prop, context),
      `: `,
      ...genPropValue(prop.values, context),
    ]),
  )
}

export function genPropKey(
  { key: node, modifier, runtimeCamelize, handler }: IRProp,
  context: CodegenContext,
): CodeFragment[] {
  const { helper } = context

  // static arg was transformed by v-bind transformer
  if (node.isStatic) {
    // only quote keys if necessary
    const keyName = handler ? toHandlerKey(node.content) : node.content
    return [
      [
        isSimpleIdentifier(keyName) ? keyName : JSON.stringify(keyName),
        NewlineType.None,
        node.loc,
      ],
    ]
  }

  let key = genExpression(node, context)
  if (runtimeCamelize) {
    key = genCall(helper('camelize'), key)
  }
  if (handler) {
    key = genCall(helper('toHandlerKey'), key)
  }
  return ['[', modifier && `${JSON.stringify(modifier)} + `, ...key, ']']
}

export function genPropValue(
  values: SimpleExpressionNode[],
  context: CodegenContext,
): CodeFragment[] {
  if (values.length === 1) {
    return genExpression(values[0], context)
  }
  return genMulti(
    DELIMITERS_ARRAY,
    ...values.map(expr => genExpression(expr, context)),
  )
}

export function genSetInheritAttrs(
  { staticProps, dynamicProps }: SetInheritAttrsIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper } = context

  // - `undefined` : no props
  // - `false`     : all props are static
  // - `string[]`  : list of props are dynamic
  // - `true`      : all props as dynamic
  const value =
    dynamicProps === true
      ? 'true'
      : dynamicProps.length
        ? genMulti(
            DELIMITERS_ARRAY,
            ...dynamicProps.map(p => JSON.stringify(p)),
          )
        : staticProps
          ? 'false'
          : null
  if (value == null) return []
  return [NEWLINE, ...genCall(vaporHelper('setInheritAttrs'), value)]
}

function getRuntimeHelper(
  tag: string,
  keyName: string,
  modifier: '.' | '^' | undefined,
) {
  const tagName = tag.toUpperCase()
  let helperName: VaporHelper
  let omitKey = false

  if (modifier) {
    if (modifier === '.') {
      const helper = getSpecialHelper(keyName, tagName)
      if (helper) {
        helperName = helper.name
        omitKey = helper.omitKey
      } else {
        helperName = 'setDOMProp'
        omitKey = false
      }
    } else {
      helperName = 'setAttr'
    }
  } else {
    const attrCacheKey = `${tagName}_${keyName}`
    const helper = getSpecialHelper(keyName, tagName)
    if (helper) {
      helperName = helper.name
      omitKey = helper.omitKey
    } else if (
      attributeCache[attrCacheKey] === undefined
        ? (attributeCache[attrCacheKey] = shouldSetAsAttr(tagName, keyName))
        : attributeCache[attrCacheKey]
    ) {
      helperName = 'setAttr'
    } else if (
      (isHTMLTag(tag) && isHTMLGlobalAttr(keyName)) ||
      (isSVGTag(tag) && isSvgGlobalAttr(keyName)) ||
      (isMathMLTag(tag) && isMathMLGlobalAttr(keyName))
    ) {
      helperName = 'setDOMProp'
    } else {
      helperName = 'setDynamicProp'
    }
  }
  return { helperName, omitKey }
}

const specialHelpers: Record<string, { name: VaporHelper; omitKey: boolean }> =
  {
    class: { name: 'setClass', omitKey: true },
    style: { name: 'setStyle', omitKey: true },
    innerHTML: { name: 'setHtml', omitKey: true },
    textContent: { name: 'setText', omitKey: true },
  }

const getSpecialHelper = (
  keyName: string,
  tagName: string,
): { name: VaporHelper; omitKey: boolean } | null => {
  // special case for 'value' property
  if (keyName === 'value' && canSetValueDirectly(tagName)) {
    return { name: 'setValue', omitKey: true }
  }

  return specialHelpers[keyName] || null
}

// those runtime helpers will return the prevValue
const helpersNeedCachedReturnValue = [
  'setStyle',
  'setDynamicProp',
  'setDynamicProps',
]

function processPropValues(
  context: CodegenContext,
  helperName: string,
  values: CodeFragment[][],
): { prevValueName: string | undefined; shouldWrapInParentheses: boolean } {
  const { shouldCacheRenderEffectDeps, processingRenderEffect } = context
  // single-line render effect and the operation needs cache return a value,
  // the expression needs to be wrapped in parentheses.
  // e.g. _foo === _ctx.foo && (_foo = _setStyle(...))
  let shouldWrapInParentheses: boolean = false
  let prevValueName
  if (shouldCacheRenderEffectDeps()) {
    const needReturnValue = helpersNeedCachedReturnValue.includes(helperName)
    processValues(context, values, !needReturnValue)
    const { declareNames } = processingRenderEffect!
    // if the operation needs to cache the return value and has multiple declareNames,
    // combine them into a single name as the return value name.
    if (declareNames.size > 0 && needReturnValue) {
      prevValueName = [...declareNames].join('')
      declareNames.add(prevValueName)
    }
    shouldWrapInParentheses = processingRenderEffect!.operations.length === 1
  }
  return { prevValueName, shouldWrapInParentheses }
}

export function processValues(
  context: CodegenContext,
  values: CodeFragment[][],
  needRewrite: boolean = true,
): string[] {
  const allCheckExps: string[] = []
  values.forEach(value => {
    const checkExps = processValue(context, value, needRewrite)
    if (checkExps) allCheckExps.push(...checkExps, ' && ')
  })

  return allCheckExps.length > 0
    ? (context.processingRenderEffect!.earlyCheckExps = [
        ...new Set(allCheckExps),
      ])
    : []
}

function processValue(
  context: CodegenContext,
  values: CodeFragment[],
  needRewrite: boolean = true,
): string[] | undefined {
  const { processingRenderEffect, allRenderEffectSeenNames } = context
  const { declareNames, rewrittenNames, earlyCheckExps, operations } =
    processingRenderEffect!

  const isSingleLine = operations.length === 1
  for (const frag of values) {
    if (!isArray(frag)) continue
    // [code, newlineIndex, loc, name] -> [(_name = code), newlineIndex, loc, name]
    const [newName, , , rawName] = frag
    if (rawName) {
      let name = rawName.replace(/[^\w]/g, '_')
      if (rewrittenNames.has(name)) continue
      rewrittenNames.add(name)

      name = `_${name}`
      if (declareNames.has(name)) continue

      if (allRenderEffectSeenNames[name] === undefined)
        allRenderEffectSeenNames[name] = 0
      else name += ++allRenderEffectSeenNames[name]

      declareNames.add(name)
      earlyCheckExps.push(`${name} !== ${newName}`)

      if (needRewrite && isSingleLine) {
        // replace the original code fragment with the assignment expression
        frag[0] = `(${name} = ${newName})`
      }
    }
  }

  if (earlyCheckExps.length > 0) {
    return [[...new Set(earlyCheckExps)].join(' && ')]
  }
}
