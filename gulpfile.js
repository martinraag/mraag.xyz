require('./env');
const autoprefixer = require('autoprefixer');
const concat = require('gulp-concat');
const del = require('del');
const envify = require('gulp-envify');
const gulp = require('gulp');
const tailwindcss = require('tailwindcss');
const postcss = require('gulp-postcss');
const rev = require('gulp-rev');

gulp.task('js', () =>
  gulp
    .src('./js/**/*.js')
    .pipe(concat('main.js'))
    .pipe(envify())
    .pipe(rev())
    .pipe(gulp.dest('./site/js'))
    .pipe(rev.manifest())
    .pipe(gulp.dest('./site/js'))
);

gulp.task('css', () =>
  gulp
    .src('./css/*.css')
    .pipe(postcss([tailwindcss, autoprefixer]))
    .pipe(rev())
    .pipe(gulp.dest('./site/css'))
    .pipe(rev.manifest())
    .pipe(gulp.dest('./site/css'))
);

gulp.task('watch', function() {
  gulp.watch('./css/**/*.css', gulp.parallel('css'));
  gulp.watch('./js/**/*.js', gulp.parallel('js'));
});

gulp.task('clean', () => del(['./site/js/**/*', './site/css/**/*']));

gulp.task('build', gulp.parallel('css', 'js'));
