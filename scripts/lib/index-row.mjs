/**
 * One index.json row from a family record. Shared by sync.mjs and build-index.mjs.
 *
 * Keys added after v1 (variable, axes, subsets) are additive: older Delta
 * versions read slug/name/fontFamily/category/weightCount/license only.
 */
export function indexRow( rec ) {
	const row = {
		slug: rec.slug,
		name: rec.name,
		fontFamily: rec.fontFamily || rec.name,
		category: rec.category || 'sans-serif',
		weightCount: Array.isArray( rec.fontFace ) ? rec.fontFace.length : 0,
		license: rec.license || 'OFL-1.1',
	};
	if ( 'boolean' === typeof rec.variable ) {
		row.variable = rec.variable;
	}
	if ( Array.isArray( rec.axes ) && rec.axes.length ) {
		row.axes = rec.axes.map( ( a ) => a.tag );
	}
	if ( Array.isArray( rec.subsets ) && rec.subsets.length ) {
		row.subsets = rec.subsets;
	}
	return row;
}
