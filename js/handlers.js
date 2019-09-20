/**
 * Access deeply nested value in object or return null.
 * @param {Object} obj
 * @param {Array} path
 */
const get = (obj, path) =>
  path.reduce(
    (parent, child) => (parent && parent[child] ? parent[child] : null),
    obj
  );

/**
 * Track pageview for non-html content
 */
document.addEventListener('click', function(event) {
  const href = get(event, ['target', 'attributes', 'href']);
  if (!href || href !== '/resume') {
    return;
  }
  ga('send', 'pageview', '/resume/');
});
