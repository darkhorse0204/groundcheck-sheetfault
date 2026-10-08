# Exports the .docx to PDF with Microsoft Word (the same engine the author's reader will use) and refreshes fields.
param([string]$Docx = (Join-Path $PSScriptRoot 'Verify_before_you_write_Jerath_Jagadeesan.docx'))
$Pdf = [System.IO.Path]::ChangeExtension($Docx, '.pdf')
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($Docx, $false, $true)
    $doc.Repaginate()
    $doc.ExportAsFixedFormat($Pdf, 17, $false, 0, 0, 1, 1, 0, $true, 1, 0, $true, $true, $false)
    Write-Output ("pages: " + $doc.ComputeStatistics(2))
    Write-Output ("words: " + $doc.ComputeStatistics(0))
    $doc.Close($false)
} finally {
    $word.Quit()
}
Write-Output "wrote $Pdf"
