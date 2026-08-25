#!/usr/bin/env node
/**
 * Rebuild index.json from families/*.json (no network).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const FAMILIES_DIR = join( ROOT, 'families' );
const INDEX_PATH = join( ROOT, 'index.json' );

const files = ( await readdir( FAMILIES_DIR ) ).filter( ( f ) => f.endsWith( '.json' ) ).sort();
const families = [];
for ( const file of files ) {
	const rec = JSON.parse( await readFile( join( FAMILIES_DIR, file ), 'utf8' ) );
	if ( ! rec.slug || ! rec.name ) {
		continue;
	}
	families.push( {
		slug: rec.slug,
		name: rec.name,
		fontFamily: rec.fontFamily || rec.name,
		category: rec.category || 'sans-serif',
		weightCount: Array.isArray( rec.fontFace ) ? rec.fontFace.length : 0,
		license: rec.license || 'OFL-1.1',
	} );
}
families.sort( ( a, b ) => a.name.localeCompare( b.name ) );

let updatedAt = new Date().toISOString();
try {
	const prev = JSON.parse( await readFile( INDEX_PATH, 'utf8' ) );
	const prevSlugs = JSON.stringify( ( prev.families || [] ).map( ( f ) => [ f.slug, f.weightCount ] ) );
	const nextSlugs = JSON.stringify( families.map( ( f ) => [ f.slug, f.weightCount ] ) );
	if ( prevSlugs === nextSlugs && prev.updatedAt ) {
		updatedAt = prev.updatedAt;
	}
} catch {
	// first write
}

const index = {
	version: 1,
	updatedAt,
	provider: 'google',
	families,
};
await writeFile( INDEX_PATH, JSON.stringify( index, null, '\t' ) + '\n' );
console.log( `index.json ${ families.length } families` );
