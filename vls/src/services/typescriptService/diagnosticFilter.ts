import type ts from 'typescript';
import { RuntimeLibrary } from '../dependencyService';

type DiagnosticFilter = (diagnostic: ts.Diagnostic) => boolean;

export function createTemplateDiagnosticFilter(tsModule: RuntimeLibrary['typescript']) {
  /**
   * Ignores errors when accessing `private` or `protected` members on component.
   *
   * ```vue
   * <template>
   *   <!-- `a` is private but should not provide an error -->
   *   <p>{{ a }}</p>
   * </template>
   *
   * <script lang="ts">
   * import Vue from 'vue'
   * import Component from 'vue-class-component'
   *
   * @Component
   * export default class MyComp extends Vue {
   *   private a = 'Hi'
   * }
   * </script>
   * ```
   */
  const ignorePrivateProtectedViolation: DiagnosticFilter = diag => {
    const protectedViolationCode = 2445;
    const privateViolationCode = 2341;

    if (diag.code !== protectedViolationCode && diag.code !== privateViolationCode) {
      return true;
    }

    const source = diag.file;
    if (!source) {
      return true;
    }

    // Only ignore accesses to a member of a component instance
    const target = findNodeFromDiagnostic(diag, source);
    if (target && tsModule.isPropertyAccessExpression(target.parent)) {
      if (target.parent.expression.kind === tsModule.SyntaxKind.ThisKeyword) {
        return false;
      }
    }

    return true;
  };

  const ignoreNoImplicitAnyViolationInNativeEvent: DiagnosticFilter = diag => {
    const noImplicitAnyViolation = [7006, 7031];

    if (!noImplicitAnyViolation.includes(diag.code)) {
      return true;
    }

    const source = diag.file;
    if (!source) {
      return true;
    }

    const target = findNodeFromDiagnostic(diag, source);
    if (target && (tsModule.isParameter(target.parent) || tsModule.isBindingElement(target.parent))) {
      return false;
    }

    return true;
  };

  return mergeFilter([ignorePrivateProtectedViolation, ignoreNoImplicitAnyViolationInNativeEvent]);
}

export function createScriptSetupDiagnosticFilter(tsModule: RuntimeLibrary['typescript']): DiagnosticFilter {
  const ignoreUnusedVariableViolation: DiagnosticFilter = diag => {
    const unusedVariableViolation = [6133];
    const ignoreNodeFns = [tsModule.isVariableStatement, tsModule.isFunctionDeclaration, tsModule.isImportDeclaration];

    if (!unusedVariableViolation.includes(diag.code)) {
      return true;
    }

    const source = diag.file;
    if (!source) {
      return true;
    }

    const target = findNodeFromDiagnostic(diag, source);

    const node = findXXXFromNodeParent(target, ignoreNodeFns);
    if (node && tsModule.isSourceFile(node.parent)) {
      return false;
    }

    return true;
  };

  return ignoreUnusedVariableViolation;
}

/**
 * Merge an array of filter to create a filter function.
 */
function mergeFilter(filters: DiagnosticFilter[]): DiagnosticFilter {
  return diag => {
    return filters.every(f => f(diag));
  };
}

/**
 * Walk AST tree and get a node which the diagnostic probably refers.
 */
function findNodeFromDiagnostic(diag: ts.Diagnostic, node: ts.Node): ts.Node | undefined {
  if (diag.start === undefined || diag.length === undefined) {
    return undefined;
  }

  if (diag.start < node.getStart() || node.getEnd() < diag.start + diag.length) {
    return undefined;
  }

  const childMatch = node.getChildren().reduce<ts.Node | undefined>((matched, child) => {
    return matched || findNodeFromDiagnostic(diag, child);
  }, undefined);

  return childMatch ? childMatch : node;
}

function findXXXFromNodeParent<T extends ts.Node>(
  node: ts.Node | undefined,
  fns: Array<(node: ts.Node) => boolean>
): ts.Node | undefined {
  if (!node) {
    return undefined;
  }
  if (fns.some(fn => fn(node))) {
    return node as T;
  }
  return findXXXFromNodeParent(node.parent, fns);
}
