with open('server.js.v717', 'r', encoding='utf-8') as f:
    lines = f.read().splitlines()

new_lines = []
for l in lines:
    # 1. crestImg onerror
    if 'banner-crest' in l and 'onerror' in l:
        new_lines.append("    return '<img src=\"' + esc(url) + '\" alt=\"' + esc(name) + '\" class=\"banner-crest\" onerror=\"this.style.display=\\'none\\'\">';")
    # 2. simulate-bet-btn
    elif 'simulate-bet-btn' in l and 'saveSimulatedBet' in l:
        new_lines.append("      '<button type=\"button\" class=\"simulate-bet-btn\" onclick=\"saveCurrentSimulatedRec()\">' +")
    # 3. market simulate button
    elif 'league-chip' in l and 'saveSimulatedBet' in l:
        new_lines.append("            '<button type=\"button\" class=\"league-chip\" style=\"padding:4px 8px;font-size:11px;background:#ffb45d;color:#080b10;font-weight:800;border:0;cursor:pointer\" onclick=\"saveCurrentSimulatedMarket(' + _mkIdx + ')\">' +")
    # 4. pass _mkIdx
    elif 'data.markets.map(function(mk){' in l:
        new_lines.append("      data.markets.map(function(mk, _mkIdx){")
    # 5. store active analysis
    elif "const decisionClass = data.betEligible ? 'bet' : 'noBet';" in l:
        new_lines.append("  window.__activeAnalysis = { match: m, data: data, recOdds: recOdds, recProb: recProb };")
        new_lines.append("  const decisionClass = data.betEligible ? 'bet' : 'noBet';")
    # 6. settleBet
    elif "onclick=\"settleBet(" in l:
        # Replace the broken escaped single quotes
        # was: onclick="settleBet(\'' + b.id + '\', 'won')"
        l = l.replace("onclick=\"settleBet(\\'' + b.id + '\\', 'won')\"", "onclick=\"settleBet(' + b.id + ', \\'won\\')\"")
        l = l.replace("onclick=\"settleBet(\\'' + b.id + '\\', 'lost')\"", "onclick=\"settleBet(' + b.id + ', \\'lost\\')\"")
        l = l.replace("onclick=\"settleBet(\\'' + b.id + '\\', 'void')\"", "onclick=\"settleBet(' + b.id + ', \\'void\\')\"")
        l = l.replace("onclick=\"settleBet(\\'' + b.id + '\\', 'pending')\"", "onclick=\"settleBet(' + b.id + ', \\'pending\\')\"")
        # In case quotes were slightly different:
        if "onclick=\"settleBet(" in l and "b.id" in l:
            # Let's use data attribute or clean replacement
            import re
            l = re.sub(r'onclick="settleBet\([^"]+\)"', lambda m: m.group(0).replace("\\'' + b.id + '\\'", "' + b.id + '"), l)
        new_lines.append(l)
    # 7. deleteBet
    elif "onclick=\"deleteBet(" in l:
        import re
        l = re.sub(r'onclick="deleteBet\([^"]+\)"', lambda m: m.group(0).replace("\\'' + b.id + '\\'", "' + b.id + '"), l)
        new_lines.append(l)
    else:
        new_lines.append(l)

code = '\n'.join(new_lines)

helpers = '''
window.saveCurrentSimulatedRec = function() {
  if (!window.__activeAnalysis) return;
  var a = window.__activeAnalysis;
  window.saveSimulatedBet(
    a.match.home,
    a.match.homeCrest || '',
    a.match.away,
    a.match.awayCrest || '',
    a.match.competition || '',
    a.data.recommendation,
    a.recOdds,
    a.recProb,
    a.data.confidence,
    a.data.confidenceLevel
  );
};

window.saveCurrentSimulatedMarket = function(idx) {
  if (!window.__activeAnalysis || !window.__activeAnalysis.data.markets) return;
  var a = window.__activeAnalysis;
  var mk = a.data.markets[idx];
  if (!mk) return;
  window.saveSimulatedBet(
    a.match.home,
    a.match.homeCrest || '',
    a.match.away,
    a.match.awayCrest || '',
    a.match.competition || '',
    mk.name,
    mk.bestOdds || 1.90,
    mk.probability || 50,
    a.data.confidence,
    a.data.confidenceLevel
  );
};
'''

code = code.replace('window.saveSimulatedBet = function(home,', helpers + '\nwindow.saveSimulatedBet = function(home,')

# Version badge V8.0.0
code = code.replace('V7.17.0 ANALYST', 'V8.0.0 ANALYST')
code = code.replace('MK Bets V7.17', 'MK Bets V8.0.0')

# UTF-8 header
code = code.replace("res.type('html').send(renderPage());", "res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(renderPage());")

with open('server.js.pytest', 'w', encoding='utf-8') as f:
    f.write(code)

print('Successfully generated server.js.pytest!')
