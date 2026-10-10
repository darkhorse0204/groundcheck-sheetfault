# Opens the .docx in Microsoft Word, records the page and vertical position of every float bookmark (and of the character
# just before it), and exports the PDF. fit_floats.py reads the JSON to find floats that left a large gap behind them.
param(
    [string]$Docx = (Join-Path $PSScriptRoot 'Verify_before_you_write_Jerath_Jagadeesan.docx'),
    [string]$Json = (Join-Path $PSScriptRoot 'probe.json'),
    [switch]$NoPdf
)
$Pdf = [System.IO.Path]::ChangeExtension($Docx, '.pdf')
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($Docx, $false, $true)
    $doc.Repaginate()
    $doc.Bookmarks.ShowHidden = $true
    $rows = @()
    foreach ($bm in $doc.Bookmarks) {
        if ($bm.Name -like '_fl_*') {
            $s = $bm.Range.Start
            $r0 = $doc.Range($s, $s)
            $p = [Math]::Max(0, $s - 1)
            $r1 = $doc.Range($p, $p)
            $rows += [pscustomobject]@{
                name = $bm.Name; start = $s
                page = $r0.Information(3); y = $r0.Information(6)
                ppage = $r1.Information(3); py = $r1.Information(6)
            }
        }
    }
    $pages = $doc.ComputeStatistics(2)
    $out = [pscustomobject]@{ pages = $pages; floats = @($rows | Sort-Object start) }
    $out | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Json
    if (-not $NoPdf) {
        $doc.ExportAsFixedFormat($Pdf, 17, $false, 0, 0, 1, 1, 0, $true, 1, 0, $true, $true, $false)
    }
    $doc.Close($false)
    Write-Output "pages: $pages"
} finally {
    $word.Quit()
}
