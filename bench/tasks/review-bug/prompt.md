Switch `pageBounds()` in `lib/pager.js` from an inclusive range `[first, last]`
to a half-open range `[start, stop)`, so the result can go straight into
`items.slice(start, stop)`. Update `paginate()` and the tests to match.
