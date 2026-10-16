exports.run = async ctx => {
  ctx.mockup = true
  await require('./git-management.cjs').run(ctx)
}
