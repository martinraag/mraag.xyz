require('./env');
const moment = require('moment');
const rssPlugin = require('@11ty/eleventy-plugin-rss');
const svgContentsPlugin = require('eleventy-plugin-svg-contents');
const syntaxHighlightPlugin = require('@11ty/eleventy-plugin-syntaxhighlight');

module.exports = function(config) {
  // Add plugins
  config.addPlugin(rssPlugin);
  config.addPlugin(svgContentsPlugin);
  config.addPlugin(syntaxHighlightPlugin);
  // Add filters
  config.addFilter('date', date => moment(date).format('MMMM D, YYYY'));
  config.addFilter('firstParagraph', content => content.split('</p>')[0]);
  // Copy static assets
  config.addPassthroughCopy('./site/images');
  config.addPassthroughCopy('./site/css/*.css');
  config.addPassthroughCopy('./site/js/*.js');
  config.addPassthroughCopy('./site/assets');
  return {
    dir: {
      input: 'site',
      output: 'dist',
    },
    templateFormats: ['njk', 'md'],
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'md',
  };
};
