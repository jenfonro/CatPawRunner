import * as esbuild from 'esbuild';
import fs from 'fs';
import { createHash } from 'crypto';

const buildVersion = typeof process.env.CATPAWRUNNER_VERSION === 'string' ? process.env.CATPAWRUNNER_VERSION.trim() : '';

esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: 'dist/index.js',
    bundle: true,
    minify: true,
    write: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
    define: {
        'globalThis.__CATPAWRUNNER_BUILD_VERSION__': JSON.stringify(buildVersion),
    },
    plugins: [genMd5()],
});

function genMd5() {
    return {
        name: 'gen-output-file-md5',
        setup(build) {
            build.onEnd(async (_) => {
                const md5 = createHash('md5').update(fs.readFileSync('dist/index.js')).digest('hex');
                fs.writeFileSync('dist/index.js.md5', md5);
            });
        },
    };
}
