# Cutting a Release

```sh
# 1. Tag HEAD with a version + message (the message becomes the release headline)
git tag -a v1.0 -m "Initial public release — trajectory map, efficiency panel, REST API"

# 2. Push the tag
git push origin v1.0

# 3. Build (runs changelog automatically, names the dist folder forestry-v1.0/)
node build_release.mjs --compress
```

`CHANGELOG.md` is written automatically during the build. To preview it beforehand:

```sh
node changelog.mjs           # preview only
node changelog.mjs --write   # write without building
```

## Notes

- Untagged builds use `dev-<hash>` as the version string so you can still build between releases.
- Each changelog section only includes commits since the previous tag.
- Tags don't push automatically — always `git push origin <tag>` separately.
