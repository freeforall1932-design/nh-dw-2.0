const path = require('path');

module.exports = {
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ]
  },
  entry: {
    background: './src/background/background.ts',
    content: './src/content/content.ts',
    updateContent: './src/content/updateContent.ts',
    listControls: './src/content/listControls.ts',
    preview: './src/preview/preview.ts',
    getGalleries: './src/preview/getGalleries.ts',
    options: './src/options/options.ts',
    offscreen: './src/offscreen/offscreen.ts'
  },
  resolve: {
    extensions: ['.ts'],
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'js'),
    clean: true
  },
};