#!/usr/bin/env node
/**
 * Purge jsDelivr CDN cache for the catalog.
 *
 * Delta sites fetch index.json and then families/{slug}.json from
 * https://cdn.jsdelivr.net/gh/21press/delta-fonts@main/. Purging only
 * index.json leaves stale family files on some edges for up to 12h, so
 * purge every catalog file a change touched.
 *
 *   node scripts/purge-jsdelivr.mjs                   # index.json only
 *   node scripts/purge-jsdelivr.mjs --changed A..B    # index.json + catalog files changed between commits
 *   node scripts/purge-jsdelivr.mjs --all             # index.json + every family file
 *   node scripts/purge-jsdelivr.mjs families/inter.json …
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const PREFIX = process.env.JSDELIVR_PURGE_PREFIX || '/gh/21press/delta-fonts@main/';
const API = 'https://purge.jsdelivr.net/';
const BATCH = 50;
const POLL_MS = 2000;
const POLL_LIMIT = 30;

const isCatalogFile = ( file ) => file === 'index.json' || /^families\/[a-z0-9-]+\.json$/.test( file );

function changedFiles( range ) {
	// Deleted families are purged too: the CDN should stop serving them.
	const out = execFileSync( 'git', [ 'diff', '--name-only', range, '--', 'index.json', 'families' ], {
		cwd: ROOT,
		encoding: 'utf8',
	} );
	return out.split( '\n' ).map( ( line ) => line.trim() ).filter( Boolean );
}

function allFiles() {
	return readdirSync( join( ROOT, 'families' ) )
		.filter( ( name ) => name.endsWith( '.json' ) )
		.map( ( name ) => `families/${ name }` );
}

function filesFromArgs( argv ) {
	if ( argv.includes( '--all' ) ) {
		return allFiles();
	}
	const at = argv.indexOf( '--changed' );
	if ( at !== -1 ) {
		const range = argv[ at + 1 ];
		if ( ! range ) {
			throw new Error( '--changed needs a commit range, e.g. HEAD~1..HEAD' );
		}
		return changedFiles( range );
	}
	return argv.filter( ( arg ) => ! arg.startsWith( '--' ) );
}

const sleep = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) );

async function requestJson( url, init ) {
	const res = await fetch( url, { ...init, headers: { Accept: 'application/json', ...( init?.headers || {} ) } } );
	const text = await res.text();
	let body;
	try {
		body = JSON.parse( text );
	} catch {
		body = null;
	}
	if ( ! res.ok || ! body ) {
		throw new Error( `jsDelivr purge failed (${ res.status }): ${ url }\n${ text.slice( 0, 500 ) }` );
	}
	return body;
}

/**
 * Purge one batch and wait for the result.
 *
 * @return {Promise<string[]>} Paths jsDelivr throttled (recently purged).
 */
async function purgeBatch( paths ) {
	const job = await requestJson( API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( { path: paths } ),
	} );
	let status = job;
	for ( let i = 0; status.status !== 'finished' && i < POLL_LIMIT; i++ ) {
		await sleep( POLL_MS );
		status = await requestJson( `${ API }status/${ job.id }` );
	}
	if ( status.status !== 'finished' ) {
		throw new Error( `jsDelivr purge ${ job.id } did not finish (status: ${ status.status })` );
	}
	return Object.entries( status.paths || {} )
		.filter( ( [ , result ] ) => result.throttled )
		.map( ( [ path ] ) => path );
}

const files = [ ...new Set( [ 'index.json', ...filesFromArgs( process.argv.slice( 2 ) ) ] ) ].filter( isCatalogFile );
const paths = files.map( ( file ) => PREFIX + file );
const throttled = [];

for ( let i = 0; i < paths.length; i += BATCH ) {
	throttled.push( ...( await purgeBatch( paths.slice( i, i + BATCH ) ) ) );
}

console.log( `Purged ${ paths.length - throttled.length } of ${ paths.length } catalog file(s) under ${ PREFIX }` );
if ( throttled.length ) {
	// Throttled = purged very recently; the edge already has a fresh copy or will soon.
	console.warn( `Throttled (recently purged, skipped): ${ throttled.length }` );
	for ( const path of throttled.slice( 0, 20 ) ) {
		console.warn( `  ${ path }` );
	}
}
