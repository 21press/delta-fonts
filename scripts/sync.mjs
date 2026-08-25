#!/usr/bin/env node
/**
 * Fetch Google Fonts metadata, resolve latin woff2 URLs via CSS2, write
 * families/{slug}.json + index.json.
 *
 * GOOGLE_FONTS_API_KEY — Webfonts API (preferred).
 * Fallback: https://fonts.google.com/metadata/fonts (no key).
 *
 * Optional: SYNC_LIMIT=N  SYNC_CONCURRENCY=8
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const FAMILIES_DIR = join( ROOT, 'families' );
const INDEX_PATH = join( ROOT, 'index.json' );

const CSS_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CATEGORY_STACK = {
	'sans-serif': 'sans-serif',
	serif: 'serif',
	display: 'system-ui',
	handwriting: 'cursive',
	monospace: 'monospace',
};

const GENERIC = new Set( Object.keys( CATEGORY_STACK ) );

function slugify( name ) {
	return String( name )
		.normalize( 'NFKD' )
		.replace( /[\u0300-\u036f]/g, '' )
		.toLowerCase()
		.replace( /[^a-z0-9]+/g, '-' )
		.replace( /^-+|-+$/g, '' );
}

function cssFamily( name ) {
	return /[^a-zA-Z-]/.test( name ) ? `"${ name.replace( /"/g, '' ) }"` : name;
}

function fontStack( name, category ) {
	const generic = CATEGORY_STACK[ category ] || 'sans-serif';
	return `${ cssFamily( name ) }, ${ generic }`;
}

function parseVariant( raw ) {
	const v = String( raw ).toLowerCase();
	if ( 'regular' === v ) {
		return { weight: '400', style: 'normal' };
	}
	if ( 'italic' === v ) {
		return { weight: '400', style: 'italic' };
	}
	const m = v.match( /^(\d+)(italic)?$/ );
	if ( ! m ) {
		return null;
	}
	return { weight: m[ 1 ], style: m[ 2 ] ? 'italic' : 'normal' };
}

function normalizeCategory( raw ) {
	const c = String( raw || '' )
		.toLowerCase()
		.replace( /\s+/g, '-' );
	if ( GENERIC.has( c ) ) {
		return c;
	}
	if ( c.includes( 'sans' ) ) {
		return 'sans-serif';
	}
	if ( c.includes( 'serif' ) ) {
		return 'serif';
	}
	if ( c.includes( 'hand' ) || c.includes( 'script' ) ) {
		return 'handwriting';
	}
	if ( c.includes( 'mono' ) ) {
		return 'monospace';
	}
	return 'display';
}

async function fetchText( url, headers = {}, retries = 4 ) {
	let lastErr;
	for ( let i = 0; i < retries; i++ ) {
		const res = await fetch( url, { headers } );
		if ( 429 === res.status || res.status >= 500 ) {
			await new Promise( ( r ) => setTimeout( r, 500 * 2 ** i ) );
			lastErr = new Error( `HTTP ${ res.status } ${ url }` );
			continue;
		}
		if ( ! res.ok ) {
			throw new Error( `HTTP ${ res.status } ${ url }` );
		}
		return res.text();
	}
	throw lastErr || new Error( `fetch failed ${ url }` );
}

async function fetchJson( url, headers = {} ) {
	const text = await fetchText( url, { Accept: 'application/json', ...headers } );
	return JSON.parse( text );
}

async function loadFromWebfontsApi( key ) {
	const url = `https://www.googleapis.com/webfonts/v1/webfonts?sort=alpha&key=${ encodeURIComponent( key ) }`;
	const data = await fetchJson( url );
	const items = Array.isArray( data.items ) ? data.items : [];
	return items.map( ( item ) => {
		const variants = Array.isArray( item.variants ) ? item.variants : [ 'regular' ];
		return {
			name: String( item.family || '' ),
			category: normalizeCategory( item.category ),
			variants,
		};
	} );
}

async function loadFromMetadata() {
	const raw = await fetchText( 'https://fonts.google.com/metadata/fonts', {
		Accept: 'application/json',
	} );
	const trimmed = raw.replace( /^\)\]\}'\s*/, '' );
	const data = JSON.parse( trimmed );
	const list = data.familyMetadataList || data.familyMetadata || [];
	return list.map( ( item ) => {
		const fonts = item.fonts && typeof item.fonts === 'object' ? item.fonts : {};
		const variants = Object.keys( fonts );
		const mapped =
			0 === variants.length
				? [ 'regular' ]
				: variants.map( ( k ) => {
						if ( k.endsWith( 'i' ) && /^\d+i$/.test( k ) ) {
							return k.slice( 0, -1 ) + 'italic';
						}
						if ( '400' === k ) {
							return 'regular';
						}
						if ( '400i' === k ) {
							return 'italic';
						}
						return k;
				  } );
		return {
			name: String( item.family || item.id || '' ),
			category: normalizeCategory( item.category ),
			variants: mapped,
		};
	} );
}

function css2Url( family, pairs ) {
	const spec = pairs
		.map( ( p ) => `${ 'italic' === p.style ? 1 : 0 },${ p.weight }` )
		.sort()
		.join( ';' );
	const fam = encodeURIComponent( family ).replace( /%20/g, '+' );
	return `https://fonts.googleapis.com/css2?family=${ fam }:ital,wght@${ spec }&display=swap`;
}

function parseCssFaces( css, familyName ) {
	const blocks = css.split( /@font-face\s*/i ).slice( 1 );
	const candidates = [];
	for ( const block of blocks ) {
		const family = ( block.match( /font-family:\s*['"]?([^;'"]+)/i ) || [] )[ 1 ] || familyName;
		const style = ( ( block.match( /font-style:\s*([a-z]+)/i ) || [] )[ 1 ] || 'normal' ).toLowerCase();
		const weightRaw = ( block.match( /font-weight:\s*([^\s;]+)/i ) || [] )[ 1 ] || '400';
		if ( /\s/.test( weightRaw ) ) {
			continue;
		}
		const src = ( block.match( /url\((['"]?)(https:\/\/fonts\.gstatic\.com\/[^)'"]+\.woff2)\1\)/i ) || [] )[ 2 ];
		if ( ! src ) {
			continue;
		}
		const range = ( block.match( /unicode-range:\s*([^;]+)/i ) || [] )[ 1 ] || '';
		const isLatin = /U\+0+00-00FF/i.test( range ) || '' === range;
		candidates.push( {
			family: family.replace( /['"]/g, '' ),
			style,
			weight: String( parseInt( weightRaw, 10 ) || 400 ),
			src,
			isLatin,
		} );
	}
	const best = new Map();
	for ( const face of candidates ) {
		const key = `${ face.weight };${ face.style }`;
		const prev = best.get( key );
		if ( ! prev || ( face.isLatin && ! prev.isLatin ) ) {
			best.set( key, face );
		}
	}
	return [ ...best.values() ];
}

async function resolveFaces( family, variants ) {
	const pairs = variants.map( parseVariant ).filter( Boolean );
	const uniq = [];
	const seen = new Set();
	for ( const p of pairs ) {
		const key = `${ p.weight };${ p.style }`;
		if ( seen.has( key ) ) {
			continue;
		}
		seen.add( key );
		uniq.push( p );
	}
	if ( 0 === uniq.length ) {
		uniq.push( { weight: '400', style: 'normal' } );
	}

	const chunkSize = 40;
	const faces = [];
	for ( let i = 0; i < uniq.length; i += chunkSize ) {
		const chunk = uniq.slice( i, i + chunkSize );
		const css = await fetchText( css2Url( family, chunk ), { 'User-Agent': CSS_UA } );
		faces.push( ...parseCssFaces( css, family ) );
	}

	const byKey = new Map();
	for ( const face of faces ) {
		byKey.set( `${ face.weight };${ face.style }`, face );
	}
	return uniq
		.map( ( p ) => byKey.get( `${ p.weight };${ p.style }` ) )
		.filter( Boolean )
		.map( ( face ) => ( {
			src: face.src,
			fontWeight: face.weight,
			fontStyle: face.style,
			fontFamily: family,
		} ) );
}

async function pool( items, limit, worker ) {
	const out = new Array( items.length );
	let i = 0;
	async function run() {
		while ( i < items.length ) {
			const idx = i++;
			out[ idx ] = await worker( items[ idx ], idx );
		}
	}
	await Promise.all( Array.from( { length: Math.min( limit, items.length ) }, run ) );
	return out;
}

function familyRecord( meta, fontFace ) {
	const slug = slugify( meta.name );
	return {
		slug,
		name: meta.name,
		fontFamily: fontStack( meta.name, meta.category ),
		category: meta.category,
		license: 'OFL-1.1',
		provider: 'google',
		fontFace,
	};
}

function indexFromFamilies( records ) {
	const families = records
		.filter( Boolean )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) )
		.map( ( f ) => ( {
			slug: f.slug,
			name: f.name,
			fontFamily: f.fontFamily,
			category: f.category,
			weightCount: Array.isArray( f.fontFace ) ? f.fontFace.length : 0,
			license: f.license || 'OFL-1.1',
		} ) );
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		provider: 'google',
		families,
	};
}

async function main() {
	const key = process.env.GOOGLE_FONTS_API_KEY || '';
	const limit = Number( process.env.SYNC_LIMIT || 0 );
	const concurrency = Math.max( 1, Number( process.env.SYNC_CONCURRENCY || 8 ) );

	let list = key ? await loadFromWebfontsApi( key ) : await loadFromMetadata();
	list = list.filter( ( m ) => m.name && slugify( m.name ) );
	if ( limit > 0 ) {
		list = list.slice( 0, limit );
	}
	console.log( `Syncing ${ list.length } families (concurrency ${ concurrency }, source=${ key ? 'api' : 'metadata' })` );

	await rm( FAMILIES_DIR, { recursive: true, force: true } );
	await mkdir( FAMILIES_DIR, { recursive: true } );

	let ok = 0;
	let fail = 0;
	const records = await pool( list, concurrency, async ( meta ) => {
		try {
			const fontFace = await resolveFaces( meta.name, meta.variants );
			if ( 0 === fontFace.length ) {
				throw new Error( 'no woff2 faces' );
			}
			const rec = familyRecord( meta, fontFace );
			const path = join( FAMILIES_DIR, `${ rec.slug }.json` );
			await writeFile( path, JSON.stringify( rec, null, '\t' ) + '\n' );
			ok++;
			if ( 0 === ok % 50 ) {
				console.log( `  ${ ok }/${ list.length }` );
			}
			return rec;
		} catch ( err ) {
			fail++;
			console.warn( `skip ${ meta.name }: ${ err.message }` );
			return null;
		}
	} );

	const index = indexFromFamilies( records );
	await writeFile( INDEX_PATH, JSON.stringify( index, null, '\t' ) + '\n' );
	console.log( `Wrote ${ ok } families, ${ fail } skipped, index ${ index.families.length }` );
}

main().catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
