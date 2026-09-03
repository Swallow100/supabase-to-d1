/**
 * Return strongly connected components in dependency order. An edge
 * table -> referencedTable means the referenced table must be imported first.
 */
export function dependencyGroups(tables) {
  const keys = tables.map((table) => table.sourceKey).sort();
  const known = new Set(keys);
  const dependencies = new Map(
    tables.map((table) => [
      table.sourceKey,
      new Set(table.foreignKeys.map((foreignKey) => foreignKey.referencedSourceKey).filter((key) => known.has(key))),
    ]),
  );

  const components = tarjan(keys, dependencies);
  const componentByKey = new Map();
  components.forEach((component, index) => {
    component.forEach((key) => componentByKey.set(key, index));
  });

  // parent component -> dependent component
  const outgoing = new Map(components.map((_, index) => [index, new Set()]));
  const indegree = new Map(components.map((_, index) => [index, 0]));
  for (const [child, parents] of dependencies) {
    const childComponent = componentByKey.get(child);
    for (const parent of parents) {
      const parentComponent = componentByKey.get(parent);
      if (parentComponent === childComponent || outgoing.get(parentComponent).has(childComponent)) continue;
      outgoing.get(parentComponent).add(childComponent);
      indegree.set(childComponent, indegree.get(childComponent) + 1);
    }
  }

  const componentLabel = (index) => [...components[index]].sort()[0];
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([index]) => index)
    .sort((a, b) => componentLabel(a).localeCompare(componentLabel(b)));
  const ordered = [];
  while (queue.length > 0) {
    const current = queue.shift();
    ordered.push(current);
    for (const next of [...outgoing.get(current)].sort((a, b) => componentLabel(a).localeCompare(componentLabel(b)))) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort((a, b) => componentLabel(a).localeCompare(componentLabel(b)));
      }
    }
  }

  if (ordered.length !== components.length) {
    throw new Error("Internal error while ordering dependency components.");
  }

  return ordered.map((index) => [...components[index]].sort());
}

function tarjan(keys, dependencies) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(key) {
    indexes.set(key, nextIndex);
    lowLinks.set(key, nextIndex);
    nextIndex += 1;
    stack.push(key);
    onStack.add(key);

    for (const dependency of [...(dependencies.get(key) ?? [])].sort()) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(key, Math.min(lowLinks.get(key), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(key, Math.min(lowLinks.get(key), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(key) === indexes.get(key)) {
      const component = [];
      while (stack.length > 0) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === key) break;
      }
      components.push(component);
    }
  }

  for (const key of keys) {
    if (!indexes.has(key)) visit(key);
  }
  return components;
}
