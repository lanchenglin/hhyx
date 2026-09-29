"""Interact with the same grouped sidebar a person uses; never force hidden clicks."""

def reveal_sidebar_control(page, selector):
    sidebar = page.locator('.sidebar')
    if not sidebar.is_visible():
        page.locator('[data-action="menu"]').click()
    target = sidebar.locator(selector)
    group = target.locator('xpath=ancestor::details[@data-nav-group]')
    if group.count() and group.get_attribute('open') is None:
        group.locator(':scope > summary').click()
    target.wait_for(state='visible')
    return target


def click_project_tab(page, tab):
    target = reveal_sidebar_control(page, '[data-tab="' + tab + '"]')
    target.click()
