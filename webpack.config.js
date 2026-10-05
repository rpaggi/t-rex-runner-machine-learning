'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'development',

  context: __dirname,
  entry: {
    dino: './index.js',
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.png$/,
        type: 'asset/resource'
      },
      {
        test: /\.(mp3|ogg)$/,
        type: 'asset/resource'
      }
    ]
  },
  resolve: {
    fallback: {
      path: false
    },
    modules: ['node_modules'],
    extensions: ['.js', '.min.js'],
  },
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    port: 8081,
    open: true,
  },
  cache: {
    type: 'filesystem'
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'index.html' },
        { from: 'index.css' },
        { from: 'assets', to: 'assets' },
        { from: 'machine-learning/model', to: 'model'}
      ]
    }),
  ],
};
