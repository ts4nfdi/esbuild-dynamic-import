import { promises as FsPromise } from 'fs';
import Path from 'path';
import FastGlob from 'fast-glob';
import { Plugin } from 'esbuild';

export interface DynamicImportConfig {
	transformExtensions?: string[],
	changeRelativeToAbsolute?: boolean,
	filter?: RegExp,
	loader?: string
}

export default function (config : DynamicImportConfig) : Plugin {
	if (!Array.isArray(config.transformExtensions) && !config.changeRelativeToAbsolute) {
		throw new Error('Either transformExtensions needs to be supplied or changeRelativeToAbsolute needs to be true');
	}
	const filter = config.filter ?? /\.(js|json)$/;
	const defaultLoader = config.loader ?? 'js';
	return {
		name: 'rtvision:dynamic-import',
		setup (build) {
			const cache = new Map();

			build.onLoad({ filter }, async args => {
				const resolveDir = Path.dirname(args.path);
        const fileExtension = Path.extname(args.path);
				const loader = fileExtension === '.json' ? 'json' : defaultLoader;
				const fileContents = await FsPromise.readFile(args.path, 'utf8');
				let value = cache.get(args.path);

				// cache busting check
				if (!value || value.fileContents !== fileContents) {
					const contents = await replaceImports(fileContents, resolveDir, config);
					value = { fileContents, output: { contents, loader } };
					cache.set(args.path, value);
				}
				return value.output;
			});
		}
	};
}

async function replaceImports (fileContents: string, resolveDir: string, config: DynamicImportConfig) {
	const matches = fileContents.matchAll(/import\(([^)]+)\)/g);

	const globImports = [];
	const importsToReplace = [];
	for (const match of matches) {
		// remove any comments, not handling multiline comments very well
		let destinationFile = match[1]?.replace(/(?:\/\*.*?\*\/)|(?:\/\/.*\n)/g, '').trim();

		// simple string concatenations become template strings
		if (destinationFile.trim()[0] !== '`') {
			destinationFile = destinationFile.replaceAll(/(["']\s*\+\s*)([^"'\s])/g, '${$2')// str+var
				.replaceAll(/([^"'\s])(\s*\+\s*["'])/g, '$1}')// var+str
				.replaceAll(/([^"'\s])(\s*\+\s*)([^"'\s])/g, '$1}${$3')// var+var
				.replaceAll(/["']\s*\+\s*["']/g, '')// str+str
				.replaceAll(/()(^[^"'])/g, '`${$2')// begin var
				.replaceAll(/^["']/g, '`')// begin str
				.replaceAll(/([^"'])()$/g, '$1}`')// end var
				.replaceAll(/["']$/g, '`');// end str
		}

		// remove the ` characters
		destinationFile = destinationFile.replace(/`/g, '').trim();

		// only change relative files if js file, then we can keep it a normal dynamic import
		// let node dynamically import the files. Support browser dynamic import someday?
		const fileExtension = Path.extname(destinationFile);

		if (config.changeRelativeToAbsolute && !Path.isAbsolute(destinationFile) && fileExtension === '.js' || fileExtension === '.json' ) {
			const normalizedPath = Path.normalize(`${resolveDir}/${destinationFile}`);
			fileContents = fileContents.replace(match[1], `\`${normalizedPath}\``);
		} else if (Array.isArray(config.transformExtensions) && config.transformExtensions.includes(fileExtension) && /^.*\${.*?}.*$/.test(destinationFile)) {
			importsToReplace.push({ fullImport: match[0], pathString: `\`${destinationFile}\`` });
			const transformedDestination = destinationFile.replace(/\${.*?}/g, '**/*');
			globImports.push(transformedDestination);
		}
	}

	if (globImports.length > 0) {
		const filenameImportPromises : Array<Promise<Array<string>>> = [];
		for (const globImport of globImports) {
			filenameImportPromises.push(FastGlob(globImport, { cwd: resolveDir }));
		}
		let importFilePaths : Array<string> = [];
		try {
			// Flatten array to array of filenames, filter out any rejected promises or duplicate entries
			importFilePaths = (await Promise.all(filenameImportPromises)).flat();
		} catch (e) {
			console.error(e);
		}

		// For all files ending in '.js', also allow importing without the extension
		const jsImportFilePaths = importFilePaths.filter(filePath => {
			if (/(\.js)$/.test(filePath)) {
				return [filePath, filePath.replace(/\.(js|json)$/, '')];
			}
			return [filePath];
		});
    importFilePaths = importFilePaths.concat(
			jsImportFilePaths.map(jsFilePath => {
				return jsFilePath.replace(/\.js$/, '');
			})
		);

		if (importFilePaths.length === 0) {
			return fileContents;
		}

		const uniqueFilePathsMap : Map<string, number> = new Map();
		const moduleMap : Map<string, string> = new Map();
		const dedupedImportFilePaths = importFilePaths.filter(filePath => {
			const pathNormalized = Path.normalize(`${resolveDir}/${filePath}`);
			let filterCondition = false;
			if (!uniqueFilePathsMap.has(pathNormalized)) {
				uniqueFilePathsMap.set(pathNormalized, uniqueFilePathsMap.size);
				filterCondition = true;
			}
			moduleMap.set(filePath, `_DynamicImportModule${uniqueFilePathsMap.get(pathNormalized)}`);
			return filterCondition;
		});

		const importString = dedupedImportFilePaths.reduce((accum, path, i) => {
			if (accum !== '') accum += '\n';
			return `${accum}import * as _DynamicImportModule${i} from '${path}';`;
		}, '');

		let objectMapString = 'const _DynamicImportModuleMap = {';

		for (const [key, value] of moduleMap) {
			objectMapString += `'${key}':${value},`;
		}

		// remove the extra comma added and add the closing bracket and semicolon
		objectMapString = objectMapString.replace(/.$/, '};');

    const importFunctionString = `function _DynamicImport(path) {const mod=_DynamicImportModuleMap[path];if(mod) {mod[Symbol.toStringTag]='Module';}return Promise.resolve(mod);}`;

		const jsStr = `${importString}\n${objectMapString}\n${importFunctionString}\n`;

		for (const importData of importsToReplace) {
			fileContents = fileContents.replace(importData.fullImport, `_DynamicImport(${importData.pathString})`);
		}

		fileContents = jsStr + fileContents;
	}
	return fileContents;
}
