#!/usr/bin/env node
/**
 * Purge jsDelivr CDN cache for the catalog index.json.
 * Delta sites fetch https://cdn.jsdelivr.net/gh/21press/delta-fonts@main/index.json
 */
const path =
	process.env.JSDELIVR_PURGE_PATH ||
	'gh/21press/delta-fonts@main/index.json';
const url = `https://purge.jsdelivr.net/${ path.replace( /^\//, '' ) }`;

const res = await fetch( url, {
	method: 'GET',
	headers: { Accept: 'application/json' },
} );
const text = await res.text();
let body = text;
try {
	body = JSON.stringify( JSON.parse( text ), null, 2 );
} catch {
	// keep raw text
}

if ( ! res.ok ) {
	console.error( `jsDelivr purge failed (${ res.status }): ${ url }` );
	console.error( body );
	process.exit( 1 );
}

console.log( `Purged ${ url }` );
console.log( body );
