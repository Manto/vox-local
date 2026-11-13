
import path from 'path';
import { fileURLToPath } from 'url';

import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: process.env.NODE_ENV === 'production' ? false : 'inline-source-map',
    entry: {
        background: {
            import: './src/background.js',
            chunkLoading: `import-scripts`,
        },
        content: './src/content.js',
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: '[name].js',
        clean: true, // Remove stale assets (e.g. old onnxruntime wasm) so they don't end up in release zips
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: "public",
                    to: "." // Copies to build folder
                }
            ],
        })
    ],
};

export default config;
