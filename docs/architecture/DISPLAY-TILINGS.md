# Display tilings

How cc rasters the one desk page so each monitor gets tiles at its own scale.
Part of [ONE-PAGE-FOR-THE-DESK.md](ONE-PAGE-FOR-THE-DESK.md).

Upstream cc keeps one high-res tiling per layer, at S (the largest scale on the
desk). Patch 0072 (`cc/domicile/display_regions.h`) also keeps a tiling at each
lower monitor scale the layer appears on, so each monitor gets tiles rastered
1:1 for its pixels.

## Design

- **Regions.** The browser adds every lit monitor to the page's screens
  (`DeskScreenInfos`, labeled `cc::kDomicileDisplayLabel`, placed by
  `DomicileDeskScreenInfosFor`). `WidgetBase` turns them into viewport regions
  in device pixels, each with ratio `s_i/S` (`DomicileDisplayRegionsOf`), and
  passes them to `LayerTreeHost::SetDomicileDisplayRegions`. A `<webview>`
  finds its regions from its own screen rect.
- **Tilings.** On both trees, `PictureLayerImpl::UpdateDomicileDisplayTilings`
  adds a tiling at high-res scale × each ratio the layer touches (at most
  three), using its screen space transform.
  - Priority rects are clipped to the monitor's region, so gaps and other
    monitors are never rastered at that scale.
  - The tiling is NON_IDEAL but still gets tiles.
    `CleanUpTilingsOnActiveLayer` keeps it while the monitor shows the layer.
- **Activation** (patch 0079). The pending tree's tiling mirrors the active
  one and rasters what a commit invalidated. Activation waits on those tiles
  like high-res ones (`IsTileRequiredForActivation`,
  `TilingSetRasterQueueRequired`). So a monitor never flashes a downscaled
  high-res tile.
- **Raster order.** `TilingSetRasterQueueAll` rasters each display tiling after
  the high-res tiling in every bin.
- **Draw.** `TileBasedLayerImpl::AppendQuads` covers each region from its
  tiling (`DomicileCoverage`). It falls back to high res where a tile is not
  ready: on first raster or after eviction.

Viz then scales by `s_i/S`, so a tile rastered at `s_i` maps 1:1 to display
`i`'s pixels.

## Cost

- The high-res tiling still covers the whole layer, so a lower-density monitor
  adds raster work and activation latency.
- **Tile size.** cc sizes GPU tiles from a viewport: its full width, a quarter
  of its height. Patch 0097 gives it the largest part of the widget one monitor
  shows (`DomicileTileViewportFor`) in place of the desk.
  - GPU raster runs on the GPU main thread, which also draws every monitor. A
    desk-wide tile (8288x1216 on `home-office-right-two`) is one task long
    enough to miss a frame there; sized for one monitor it is ~1376x1216.
  - A widget on no monitor keeps upstream's sizing.
- **Gaps.** The high-res tiling rasters the parts of the desk no monitor shows.
  A display tiling's clip is the bounds of every region at its ratio, so two
  monitors at one density raster what lies between them too. Clipping either
  to the regions themselves needs a per-tile check: a rect clip cannot leave
  a gap out.

## Fallback to S

These layers raster only at S. Viz resamples them on a lower-density display.

- layers under a non-root render surface: filters, blur, masks, opacity
  groups (such as a window dragged at reduced opacity)
- rotated layers
- directly composited images

A layer under a surface keeps its display tilings rastered
(`DomicileKeepsDisplayTilings`), so leaving the surface needs no rebuild. A
moving layer draws from its tilings.

## Images drawn nearest-neighbor

A display tiling downscales every image in its layer. One drawn
nearest-neighbor keeps or drops whole source columns, so thin strokes break
up. The PDF viewer drew its page bitmap that way; patch 0210 draws it
filtered (`guard-pdf-scaled-text.sh`).

## Tile memory

- **Upstream budget** (`GetGpuMemoryPolicy`): 1152 MB scaled by the widget's
  initial screen area, at least 512 MB, at most a quarter of RAM. The desk
  page starts on the host monitor, so this covers only the host's share of
  the desk.
- **`--force-gpu-mem-available-mb`**, when set, is the budget, and the desk
  budget does not apply. `domicile-launch` does not pass it, so the desk
  budget below sizes the shell's page.
- **Desk budget** (patch 0088, `DomicileTileBytesFor`): the page's pixels at S
  plus each monitor's tiling (its region × `r²`), at upstream's memory per
  screen pixel (1152 MiB per 2056x1329 at 2, ~110 bytes). At most a quarter of
  RAM. 0 for a widget on no monitor.
  - Less runs out while windows resize: cc counts every layer's tiles, both
    trees' copies, and buffers still held by viz against the budget.
  - `WidgetBase` computes it with the regions. The commit carries it, and
    `LayerTreeHostImpl::ActualManagedMemoryPolicy` raises the budget to it.
    It never lowers the budget, so upstream's is a floor.
  - `home-office-right-two` (1.5 laptop, two 1.2 4K portrait monitors,
    5520x3200 desk): 39.7 Mpx + 2 × 8.3 Mpx = 56.3 Mpx, ~5.8 GiB before the
    ceiling. Upstream gives ~583 MB.
  - `CommitState`'s copy keeps the regions and the budget for the next commit.
- Over budget, required tiles are marked OOM so activation can go ahead.
  Upstream draws an OOM tile as solid color. A display tiling's OOM tile is
  passed over instead (`DomicileDrawsTile`, patch 0098), and the high-res tile
  is drawn there, resampled. It is rastered again once memory frees up.
- **Eviction order**: display tilings are NON_IDEAL, so in each eviction phase
  their tiles go before high-res tiles, even inside a region where high res is
  only fallback.
  - Visible tiles of both stay: eviction stops at a tile of equal priority,
    and both are NOW at distance 0.
  - Ordering display tilings after high res would evict the host monitor's
    drawn high-res tiles first. A region-aware order needs per-tile checks in
    the eviction iterators.
