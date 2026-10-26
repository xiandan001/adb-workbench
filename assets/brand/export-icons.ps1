$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$brandDirectory = $PSScriptRoot
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $brandDirectory '../..'))
$masterFile = Join-Path $brandDirectory 'veylo-black-emerald-master.png'
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256, 512)
$source = [System.Drawing.Image]::FromFile($masterFile)
try {
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $outline = [System.Drawing.Drawing2D.GraphicsPath]::new()
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $radius = [single]($size * 0.19)
            $diameter = [single]($radius * 2)
            $edge = [single]($size - $diameter)
            $outline.AddArc(0, 0, $diameter, $diameter, 180, 90)
            $outline.AddArc($edge, 0, $diameter, $diameter, 270, 90)
            $outline.AddArc($edge, $edge, $diameter, $diameter, 0, 90)
            $outline.AddArc(0, $edge, $diameter, $diameter, 90, 90)
            $outline.CloseFigure()
            $graphics.SetClip($outline)
            # Export framing only: preserve the approved silhouette and color pixels.
            $destination = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
            $graphics.DrawImage($source, $destination, 192, 192, 896, 896, [System.Drawing.GraphicsUnit]::Pixel)
            $bitmap.Save((Join-Path $brandDirectory "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $outline.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $source.Dispose()
}

Copy-Item -LiteralPath (Join-Path $brandDirectory 'icon-512.png') -Destination (Join-Path $projectDirectory 'icon.png') -Force
$iconSizes = $sizes | Where-Object { $_ -le 256 }
$frames = @($iconSizes | ForEach-Object { ,([System.IO.File]::ReadAllBytes((Join-Path $brandDirectory "icon-$_.png"))) })
$stream = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$iconSizes.Count)
    $offset = 6 + 16 * $iconSizes.Count
    for ($index = 0; $index -lt $iconSizes.Count; $index++) {
        $dimension = if ($iconSizes[$index] -eq 256) { 0 } else { $iconSizes[$index] }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$index].Length)
        $writer.Write([uint32]$offset)
        $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    [System.IO.File]::WriteAllBytes((Join-Path $projectDirectory 'icon.ico'), $stream.ToArray())
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

foreach ($target in @(@{ File = 'icon.svg'; Size = 512 }, @{ File = 'public/favicon.svg'; Size = 64 })) {
    $base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $brandDirectory "icon-$($target.Size).png")))
    $svg = "<svg xmlns=`"http://www.w3.org/2000/svg`" width=`"$($target.Size)`" height=`"$($target.Size)`" viewBox=`"0 0 $($target.Size) $($target.Size)`"><image width=`"$($target.Size)`" height=`"$($target.Size)`" href=`"data:image/png;base64,$base64`" /></svg>`n"
    [System.IO.File]::WriteAllText((Join-Path $projectDirectory $target.File), $svg, [System.Text.UTF8Encoding]::new($false))
}
