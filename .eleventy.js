const moment = require('moment');
const rssPlugin = require('@11ty/eleventy-plugin-rss');
const svgContentsPlugin = require('eleventy-plugin-svg-contents');

module.exports = function(config) {
  // Add plugins
  config.addPlugin(rssPlugin);
  config.addPlugin(svgContentsPlugin);
  // Add filters
  config.addFilter('date', date => moment(date).format('MMMM D, YYYY'));
  // Copy images
  config.addPassthroughCopy('./site/images');
  config.addPassthroughCopy('./site/css');
  return {
    dir: {
      input: 'site',
      output: 'dist',
    },
    templateFormats: ['njk', 'md'],
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
};
