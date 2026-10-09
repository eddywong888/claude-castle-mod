import { expect, mock, test } from 'claude-code/testing'

// Draws the band the way Claude Code does, so a tree the engine would refuse fails here, not on screen.
test('the band draws on the desktop and stays out of the terminal', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  // Stands in for Claude Code's own band, which draws when the mod passes the terminal through.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const props = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120 }
  const desktop = await $.ui.mount({ plugin: 'castle-hud', surface: 'desktop', component: 'AbovePrompt', props } as never)
  expect(await desktop.find({ type: 'Svg' } as never)).toBeDefined()
  await desktop.unmount()
  const terminal = await $.ui.mount({ plugin: 'castle-hud', surface: 'terminal', component: 'AbovePrompt', props } as never)
  expect(await terminal.find({ type: 'Svg' } as never)).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: 'engine band' } as never)).toBeDefined()
  await terminal.unmount()
})
