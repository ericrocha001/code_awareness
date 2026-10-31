exports.run = async ctx => {
  ctx.integratedDirectActions = true
  await require('./git-atlas-live-remote.cjs').run(ctx)
}
