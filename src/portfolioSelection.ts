const portfolioSelectionStorageKey = 'project-os.selected-portfolio'

export type PortfolioSelectionStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function browserStorage(): PortfolioSelectionStorage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function loadPortfolioSelection(storage: PortfolioSelectionStorage | undefined = browserStorage()): string {
  try {
    return storage?.getItem(portfolioSelectionStorageKey) ?? ''
  } catch {
    return ''
  }
}

export function savePortfolioSelection(portfolioId: string, storage: PortfolioSelectionStorage | undefined = browserStorage()) {
  try {
    storage?.setItem(portfolioSelectionStorageKey, portfolioId)
  } catch {
    // Local storage is optional; the current page state remains usable.
  }
}
