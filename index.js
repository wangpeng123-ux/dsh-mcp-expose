/**
 * Entry shim.
 *
 * package.json#exports["."] points at ./host.js, but some Harness loaders
 * resolve a plugin directory through main/index.js instead of the export map.
 * Keeping this file makes both resolution paths land on the same module.
 */
export * from './host.js'
