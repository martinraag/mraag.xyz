require('dotenv').config();
const moment = require('moment');
const rssPlugin = require('@11ty/eleventy-plugin-rss');
const svgContentsPlugin = require('eleventy-plugin-svg-contents');

module.exports = function(config) {
  // Add plugins
  config.addPlugin(rssPlugin);
  config.addPlugin(svgContentsPlugin);
  // Add filters
  config.addFilter('date', date => moment(date).format('MMMM D, YYYY'));
  config.addFilter('firstParagraph', content => content.split('</p>')[0]);
  // Copy images
  config.addPassthroughCopy('./site/images');
  config.addPassthroughCopy('./site/css');
  config.addPassthroughCopy('./site/js');
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
