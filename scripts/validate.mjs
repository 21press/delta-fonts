#!/usr/bin/env node
/**
 * Schema check for index.json + families/*.json.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const FAMILIES_DIR = join( ROOT, 'families' );
const INDEX_PATH = join( ROOT, 'index.json' );

const errors = [];

function need( cond, msg ) {
	if ( ! cond ) {
		errors.push( msg );
	}
}

const index = JSON.parse( await readFile( INDEX_PATH, 'utf8' ) );
need( 1 === index.version, 'index.version must be 1' );
need( 'google' === index.provider, 'index.provider must be google' );
need( typeof index.updatedAt === 'string' && index.updatedAt, 'index.updatedAt required' );
need( Array.isArray( index.families ), 'index.families must be array' );

const indexSlugs = new Set();
for ( const row of index.families || [] ) {
	need( row.slug && row.name, `index row missing slug/name: ${ JSON.stringify( row ) }` );
	need( ! indexSlugs.has( row.slug ), `duplicate index slug ${ row.slug }` );
	indexSlugs.add( row.slug );
	need( Number.isInteger( row.weightCount ) && row.weightCount > 0, `${ row.slug } weightCount` );
}

const files = ( await readdir( FAMILIES_DIR ) ).filter( ( f ) => f.endsWith( '.json' ) );
const fileSlugs = new Set();
for ( const file of files ) {
	const rec = JSON.parse( await readFile( join( FAMILIES_DIR, file ), 'utf8' ) );
	const slug = rec.slug;
	need( slug && `${ slug }.json` === file, `${ file } slug mismatch` );
	need( rec.name && rec.fontFamily, `${ file } name/fontFamily` );
	need( Array.isArray( rec.fontFace ) && rec.fontFace.length > 0, `${ file } fontFace` );
	for ( const face of rec.fontFace || [] ) {
		need(
			typeof face.src === 'string' && face.src.startsWith( 'https://fonts.gstatic.com/' ) && face.src.endsWith( '.woff2' ),
			`${ file } face src must be gstatic woff2`
		);
		need( face.fontWeight && face.fontStyle, `${ file } face weight/style` );
	}
	fileSlugs.add( slug );
	need( indexSlugs.has( slug ), `${ slug } in families/ but not index` );
}

for ( const slug of indexSlugs ) {
	need( fileSlugs.has( slug ), `${ slug } in index but missing families/${ slug }.json` );
}

if ( errors.length ) {
	console.error( errors.slice( 0, 40 ).join( '\n' ) );
	if ( errors.length > 40 ) {
		console.error( `…and ${ errors.length - 40 } more` );
	}
	process.exit( 1 );
}

console.log( `ok ${ fileSlugs.size } families` );
