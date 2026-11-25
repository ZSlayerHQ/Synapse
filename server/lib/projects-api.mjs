// The project list a caller may see: id and display name, sorted by id.
export function listProjects(registry) {
  return Object.entries(registry.projects || {})
    .map(([id, p]) => ({ id, displayName: (p && p.displayName) || id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
