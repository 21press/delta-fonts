#!/usr/bin/env node
/**
 * Fetch Google Fonts metadata, resolve woff2 URLs via CSS2, write
 * families/{slug}.json + index.json.
 *
 * Each family keeps `fontFace` (one latin face per weight/style, read by every
 * Delta version) and adds, for Delta 0.2.3+:
 *   variable  — true when Google serves a variable font
 *   axes      — [{ tag, min, max, default }]
 *   subsets   — Google subsets (without the `menu` preview subset)
 *   files     — { weight: [face], all?: [face] }; one face per @font-face block
 *               Google prints (style × subset, plus each weight when static):
 *               { style, weight, stretch?, subset, unicodeRange, src }
 *               `weight` = wght axis only (or discrete weights); `all` = every
 *               axis, only for families with axes beyond wght.
 *
 * GOOGLE_FONTS_API_KEY — Webfonts API (preferred).
 * Fallback: https://fonts.google.com/metadata/fonts (no key).
 *
 * Optional: SYNC_LIMIT=N  SYNC_CONCURRENCY=8
 *           SYNC_ONLY="Inter,Roboto Flex" — refresh just these families (keeps
 *           the rest of families/ and rebuilds index.json from disk).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexRow } from './lib/index-row.mjs';

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
	const url = `https://www.googleapis.com/webfonts/v1/webfonts?sort=alpha&capability=VF&key=${ encodeURIComponent( key ) }`;
	const data = await fetchJson( url );
	const items = Array.isArray( data.items ) ? data.items : [];
	return items.map( ( item ) => {
		const variants = Array.isArray( item.variants ) ? item.variants : [ 'regular' ];
		return {
			name: String( item.family || '' ),
			category: normalizeCategory( item.category ),
			variants,
			axes: normalizeAxes(
				( Array.isArray( item.axes ) ? item.axes : [] ).map( ( a ) => ( {
					tag: a.tag,
					min: a.start,
					max: a.end,
				} ) )
			),
			subsets: normalizeSubsets( item.subsets ),
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
			axes: normalizeAxes(
				( Array.isArray( item.axes ) ? item.axes : [] ).map( ( a ) => ( {
					tag: a.tag,
					min: a.min,
					max: a.max,
					default: a.defaultValue,
				} ) )
			),
			subsets: normalizeSubsets( item.subsets ),
		};
	} );
}

function num( v ) {
	const n = Number( v );
	return Number.isFinite( n ) ? n : null;
}

/**
 * Axes as { tag, min, max, default }, ordered as CSS2 wants them: lowercase
 * tags first, then uppercase, each group A–Z.
 */
function normalizeAxes( axes ) {
	const out = [];
	for ( const a of axes ) {
		const tag = String( a.tag || '' );
		const min = num( a.min );
		const max = num( a.max );
		if ( ! /^[A-Za-z]{4}$/.test( tag ) || null === min || null === max || min > max ) {
			continue;
		}
		const row = { tag, min, max };
		if ( null !== num( a.default ) ) {
			row.default = num( a.default );
		}
		out.push( row );
	}
	const lower = ( t ) => t === t.toLowerCase();
	return out.sort( ( a, b ) => {
		if ( lower( a.tag ) !== lower( b.tag ) ) {
			return lower( a.tag ) ? -1 : 1;
		}
		return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
	} );
}

function normalizeSubsets( subsets ) {
	return ( Array.isArray( subsets ) ? subsets : [] )
		.map( String )
		.filter( ( s ) => s && 'menu' !== s );
}

function familyParam( family ) {
	return encodeURIComponent( family ).replace( /%20/g, '+' );
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

/**
 * Every @font-face block of a CSS2 response, with the subset named in the
 * comment Google prints before it. Descriptors are kept as Google prints them.
 */
const CJK_SUBSETS = [ 'japanese', 'korean', 'chinese-simplified', 'chinese-traditional', 'chinese-hongkong' ];

function parseCssBlocks( css, subsets = [] ) {
	const cjk = subsets.find( ( s ) => CJK_SUBSETS.includes( s ) ) || 'cjk';
	const out = [];
	const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/gi;
	let m;
	while ( ( m = re.exec( css ) ) ) {
		const body = m[ 2 ];
		const get = ( prop ) => ( ( body.match( new RegExp( prop + ':\\s*([^;]+);' , 'i' ) ) || [] )[ 1 ] || '' ).trim();
		const src = ( body.match( /url\((['"]?)(https:\/\/fonts\.gstatic\.com\/[^)'"]+\.woff2)\1\)/i ) || [] )[ 2 ];
		if ( ! src ) {
			continue;
		}
		// Most blocks carry a /* subset */ comment. CJK families are split into
		// numbered slices with no comment; the number is in the file name.
		const slice = src.match( /\.(\d+)\.woff2$/ );
		let subset = ( m[ 1 ] || '' ).trim();
		if ( ! subset || /^\[\d+\]$/.test( subset ) ) {
			subset = slice ? cjk : subset.replace( /^\[|\]$/g, '' ) || 'unknown';
		}
		const face = {
			style: get( 'font-style' ) || 'normal',
			weight: get( 'font-weight' ) || '400',
			subset,
			unicodeRange: get( 'unicode-range' ),
			src,
		};
		if ( slice && CJK_SUBSETS.concat( 'cjk' ).includes( subset ) ) {
			face.slice = Number( slice[ 1 ] );
		}
		const stretch = get( 'font-stretch' );
		if ( stretch ) {
			face.stretch = stretch;
		}
		out.push( face );
	}
	return out;
}

function hasItalic( variants ) {
	return variants.some( ( v ) => /italic$/i.test( String( v ) ) );
}

/**
 * CSS2 spec for the wght axis only (variable) or the listed discrete weights.
 */
function weightSpecs( meta ) {
	const wght = meta.axes.find( ( a ) => 'wght' === a.tag );
	const italic = hasItalic( meta.variants );
	if ( wght ) {
		const r = `${ wght.min }..${ wght.max }`;
		return [ italic ? `ital,wght@0,${ r };1,${ r }` : `wght@${ r }` ];
	}
	const pairs = meta.variants.map( parseVariant ).filter( Boolean );
	const uniq = [ ...new Map( pairs.map( ( p ) => [ `${ p.weight };${ p.style }`, p ] ) ).values() ];
	if ( 0 === uniq.length ) {
		return [ '' ];
	}
	if ( ! italic && uniq.every( ( p ) => '400' === p.weight ) ) {
		return [ '' ];
	}
	const specs = [];
	for ( let i = 0; i < uniq.length; i += 40 ) {
		const chunk = uniq.slice( i, i + 40 );
		specs.push(
			'ital,wght@' +
				chunk
					.map( ( p ) => `${ 'italic' === p.style ? 1 : 0 },${ p.weight }` )
					.sort()
					.join( ';' )
		);
	}
	return specs;
}

/**
 * CSS2 spec for every axis (only when the family has axes beyond wght).
 */
function allAxesSpec( meta ) {
	if ( ! meta.axes.some( ( a ) => 'wght' !== a.tag ) ) {
		return null;
	}
	const tags = meta.axes.map( ( a ) => a.tag );
	const ranges = meta.axes.map( ( a ) => ( a.min === a.max ? `${ a.min }` : `${ a.min }..${ a.max }` ) );
	if ( hasItalic( meta.variants ) ) {
		return `ital,${ tags.join( ',' ) }@0,${ ranges.join( ',' ) };1,${ ranges.join( ',' ) }`;
	}
	return `${ tags.join( ',' ) }@${ ranges.join( ',' ) }`;
}

async function fetchBlocks( meta, spec ) {
	const url = `https://fonts.googleapis.com/css2?family=${ familyParam( meta.name ) }${ spec ? ':' + spec : '' }&display=swap`;
	return parseCssBlocks( await fetchText( url, { 'User-Agent': CSS_UA } ), meta.subsets );
}

async function resolveFiles( meta ) {
	const files = { weight: [] };
	for ( const spec of weightSpecs( meta ) ) {
		files.weight.push( ...( await fetchBlocks( meta, spec ) ) );
	}
	const all = allAxesSpec( meta );
	if ( all ) {
		try {
			const blocks = await fetchBlocks( meta, all );
			if ( blocks.length ) {
				files.all = blocks;
			}
		} catch ( err ) {
			console.warn( `  ${ meta.name }: all-axes CSS failed (${ err.message }), keeping weight set only` );
		}
	}
	return files;
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

function familyRecord( meta, fontFace, files ) {
	const slug = slugify( meta.name );
	const rec = {
		slug,
		name: meta.name,
		fontFamily: fontStack( meta.name, meta.category ),
		category: meta.category,
		license: 'OFL-1.1',
		provider: 'google',
		fontFace,
		variable: meta.axes.length > 0,
		axes: meta.axes,
		subsets: meta.subsets,
	};
	if ( files && files.weight && files.weight.length ) {
		rec.files = files;
	}
	return rec;
}

function indexFromFamilies( records ) {
	const families = records
		.filter( Boolean )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) )
		.map( indexRow );
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

	const only = String( process.env.SYNC_ONLY || '' )
		.split( ',' )
		.map( ( s ) => s.trim().toLowerCase() )
		.filter( Boolean );

	let list = key ? await loadFromWebfontsApi( key ) : await loadFromMetadata();
	list = list.filter( ( m ) => m.name && slugify( m.name ) );
	if ( only.length ) {
		list = list.filter( ( m ) => only.includes( m.name.toLowerCase() ) || only.includes( slugify( m.name ) ) );
	}
	if ( limit > 0 ) {
		list = list.slice( 0, limit );
	}
	console.log( `Syncing ${ list.length } families (concurrency ${ concurrency }, source=${ key ? 'api' : 'metadata' })` );

	if ( ! only.length ) {
		await rm( FAMILIES_DIR, { recursive: true, force: true } );
	}
	await mkdir( FAMILIES_DIR, { recursive: true } );

	let ok = 0;
	let fail = 0;
	const records = await pool( list, concurrency, async ( meta ) => {
		try {
			const fontFace = await resolveFaces( meta.name, meta.variants );
			if ( 0 === fontFace.length ) {
				throw new Error( 'no woff2 faces' );
			}
			let files = null;
			try {
				files = await resolveFiles( meta );
			} catch ( err ) {
				// fontFace alone still installs on every Delta version.
				console.warn( `  ${ meta.name }: files skipped (${ err.message })` );
			}
			const rec = familyRecord( meta, fontFace, files );
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

	let all = records;
	if ( only.length ) {
		// Partial refresh: index from every family file on disk.
		all = [];
		for ( const file of ( await readdir( FAMILIES_DIR ) ).filter( ( f ) => f.endsWith( '.json' ) ) ) {
			all.push( JSON.parse( await readFile( join( FAMILIES_DIR, file ), 'utf8' ) ) );
		}
	}
	const index = indexFromFamilies( all );
	await writeFile( INDEX_PATH, JSON.stringify( index, null, '\t' ) + '\n' );
	console.log( `Wrote ${ ok } families, ${ fail } skipped, index ${ index.families.length }` );
}

main().catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
